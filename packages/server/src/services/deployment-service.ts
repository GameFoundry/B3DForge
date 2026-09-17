import { promises as fs } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import type { Server as SocketServer } from 'socket.io';
import type {
	AgentFilesSentEvent,
	Build,
	BuildConfiguration,
	BuildGroup,
	BuildPhase,
	CreateDeploymentInput,
	Deployment,
	DeploymentArtifact,
	DeploymentEligibility,
	DeploymentResult,
	DeploymentStatus,
	DeploySchema,
	LogLine,
	Project,
	PromotionScope,
	TriggerType,
} from '@banshee-forge/shared';
import { DEPLOY_SCRIPT_NAME, generateDeploymentId, isValidBranchName } from '@banshee-forge/shared';
import { ScriptSession, toUnixPath } from '@banshee-forge/shared/node';
import { BuildRepository } from '../repositories/build-repository.js';
import { BuildGroupRepository } from '../repositories/build-group-repository.js';
import { DeploymentRepository } from '../repositories/deployment-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import { AgentRegistry, RegisteredAgent } from './agent-registry.js';
import { ConfigService } from './config-service.js';
import { PromotionService, PromotionError } from './promotion-service.js';
import { readGitCredentials } from './submodule-pin-service.js';

const TERMINAL_STATUSES: DeploymentStatus[] = ['success', 'failed', 'cancelled'];

/** How long the agent may take to transfer the deploy files. */
const TRANSFER_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** How long `deploy.sh` may run on the orchestrator. */
const SCRIPT_TIMEOUT_MS = 60 * 60 * 1000;

export class DeploymentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DeploymentError';
	}
}

/**
 * Runs deployments: decides whether a build may be deployed, drives each deployment through its
 * stages (transfer the build's deploy files from its agent, run `deploy.sh` on the orchestrator,
 * optionally promote the tested commits), coordinates auto-deploy of build groups, and keeps
 * agents from purging files a deployment still needs. Deployments of one project run one at a
 * time. The orchestrator knows nothing about what `deploy.sh` does.
 */
export class DeploymentService extends EventEmitter {
	/** Per-project serial queues. */
	private queues = new Map<string, Promise<unknown>>();
	/** Deployments waiting on `agent:files-sent`, keyed by deployment id. */
	private waitingForAgent = new Map<string, { resolve: (event: AgentFilesSentEvent) => void; reject: (err: Error) => void; agentId: string }>();
	/** Deployments waiting for their agent to come online, keyed by deployment id. */
	private waitingForConnection = new Map<string, { agentName: string; resume: () => void }>();
	/** Active server-side script sessions, for cancellation. */
	private sessions = new Map<string, ScriptSession>();
	private cancelled = new Set<string>();

	constructor(
		private io: SocketServer,
		private deployments: DeploymentRepository,
		private builds: BuildRepository,
		private groups: BuildGroupRepository,
		private projects: ProjectRepository,
		private registry: AgentRegistry,
		private configService: ConfigService,
		private promotion: PromotionService,
	) {
		super();
		this.registry.on('connected', agent => this.onAgentConnected(agent));
		this.registry.on('disconnected', agent => this.onAgentDisconnected(agent));
	}

	/** Re-queue deployments that were pending and fail the ones a restart interrupted mid-flight. */
	async initialize(): Promise<void> {
		for (const project of await this.projects.findAll()) {
			for (const entry of await this.deployments.list(project.slug)) {
				if (TERMINAL_STATUSES.includes(entry.status)) continue;
				const deployment = await this.deployments.findById(project.slug, entry.id);
				if (!deployment) continue;
				if (deployment.status === 'pending') {
					this.schedule(deployment);
				} else {
					await this.appendLog(deployment, 'Deployment interrupted: server was restarted. Retry to run it again.', 'error');
					await this.finish(deployment, 'failed', 'Server restarted during deployment');
				}
			}
		}
	}

	/* ─────────── eligibility ─────────── */

	async checkEligibility(build: Build, project: Project): Promise<DeploymentEligibility> {
		const reasons: string[] = [];
		const configuration = project.configurations?.find(c => c.id === build.configurationId);

		if (build.status !== 'success') reasons.push(`Build ${build.status === 'running' || build.status === 'pending' ? 'has not finished' : build.status}`);
		const inputs = build.deploymentInputs;
		if (!inputs) reasons.push('Build recorded no deploy files; run a new build');
		else if (inputs.purged) reasons.push(`Deploy files were purged on agent ${build.agentName ?? ''}; run a new build`);
		else if (!inputs.files.some(f => f.path === DEPLOY_SCRIPT_NAME)) reasons.push(`Build left no ${DEPLOY_SCRIPT_NAME} in its deploy directory; the build script must copy it there`);

		if (configuration?.testScript) {
			if (build.config?.runTests === false) reasons.push('Tests were not run for this build');
			else if (!build.testResultsComplete) reasons.push('Test results were not ingested');
			else if (build.resultsUploadComplete === false) reasons.push('Some test result files failed to upload');
			else if (!build.testSummary || build.testSummary.total === 0) reasons.push('No test results were recorded');
			else if (build.testSummary.failed > 0) reasons.push(`${build.testSummary.failed} test(s) failed`);
		}

		const deployments = await this.deployments.listForBuild(project.slug, build.id);
		if (deployments.some(d => !TERMINAL_STATUSES.includes(d.status))) reasons.push('A deployment of this build is already in progress');

		return {
			eligible: reasons.length === 0,
			reasons,
			defaultTargetBranch: project.deployBranch ?? '',
			buildBranch: build.gitBranch,
			deployments,
		};
	}

	/** Builds whose retained files must survive an agent purge. */
	async protectedBuildIds(): Promise<string[]> {
		const ids = new Set<string>();
		for (const project of await this.projects.findAll()) {
			for (const entry of await this.deployments.list(project.slug))
				if (!TERMINAL_STATUSES.includes(entry.status)) ids.add(entry.buildId);
		}
		return Array.from(ids);
	}

	/** Record that an agent purged these builds' files, so eligibility reports it. */
	async notePurgedBuilds(buildIds: string[]): Promise<void> {
		if (buildIds.length === 0) return;
		for (const project of await this.projects.findAll()) {
			for (const buildId of buildIds) {
				const build = await this.builds.findById(project.slug, buildId);
				if (!build?.deploymentInputs || build.deploymentInputs.purged) continue;
				await this.builds.update(project.slug, buildId, { deploymentInputs: { ...build.deploymentInputs, purged: true } });
			}
		}
	}

	/* ─────────── creation ─────────── */

	async createDeployment(build: Build, project: Project, input: CreateDeploymentInput, triggerType: TriggerType, triggeredBy: string | undefined, scope: PromotionScope): Promise<Deployment> {
		const eligibility = await this.checkEligibility(build, project);
		if (!eligibility.eligible) throw new DeploymentError(eligibility.reasons.join('; '));
		const configuration = project.configurations?.find(c => c.id === build.configurationId);

		// A blank target, or the branch the build came from, means no promotion.
		let targetBranch = input.targetBranch === undefined ? eligibility.defaultTargetBranch : input.targetBranch.trim();
		if (targetBranch && !isValidBranchName(targetBranch)) throw new DeploymentError(`'${targetBranch}' is not a valid branch name`);
		if (targetBranch === build.gitBranch) targetBranch = '';

		const parameters = resolveDeployParameters(configuration?.deploySchema ?? {}, input.parameters ?? {});

		const previous = eligibility.deployments;
		const deployment: Deployment = {
			id: generateDeploymentId(),
			projectSlug: project.slug,
			buildId: build.id,
			buildNumber: build.buildNumber,
			groupId: build.groupId,
			platform: build.platform,
			configurationId: build.configurationId,
			rootCommit: build.gitCommit,
			buildBranch: build.gitBranch,
			status: 'pending',
			triggerType,
			triggeredBy,
			parameters,
			targetBranch: targetBranch || undefined,
			promotionScope: scope,
			phases: [],
			files: build.deploymentInputs!.files,
			artifacts: [],
			results: [],
			agentName: build.agentName ?? '',
			attempt: previous.length + 1,
			createdAt: new Date().toISOString(),
		};
		await this.deployments.save(deployment);
		this.emitUpdated(deployment);
		this.schedule(deployment);
		return deployment;
	}

	/** Start a fresh attempt of a finished deployment, keeping its parameters and target. */
	async retry(deployment: Deployment, triggeredBy: string | undefined): Promise<Deployment> {
		if (!TERMINAL_STATUSES.includes(deployment.status)) throw new DeploymentError('Deployment is still running');
		const build = await this.builds.findById(deployment.projectSlug, deployment.buildId);
		const project = await this.projects.findBySlug(deployment.projectSlug);
		if (!build || !project) throw new DeploymentError('Build or project no longer exists');
		return this.createDeployment(build, project, { parameters: deployment.parameters, targetBranch: deployment.targetBranch ?? '' }, 'manual', triggeredBy, deployment.promotionScope);
	}

	async cancel(deployment: Deployment): Promise<boolean> {
		if (TERMINAL_STATUSES.includes(deployment.status)) return false;
		this.cancelled.add(deployment.id);

		const waitingConnection = this.waitingForConnection.get(deployment.id);
		if (waitingConnection) {
			this.waitingForConnection.delete(deployment.id);
			waitingConnection.resume();
		}
		// A transfer in flight is abandoned: further uploads are refused and the agent's report ignored.
		const waitingAgent = this.waitingForAgent.get(deployment.id);
		if (waitingAgent) {
			this.waitingForAgent.delete(deployment.id);
			waitingAgent.reject(new DeploymentError('Cancelled'));
		}
		this.sessions.get(deployment.id)?.kill();

		if (deployment.status === 'pending' || (deployment.status === 'promoting' && deployment.pendingReason)) {
			// Nothing is running for it; settle it right away.
			await this.finish(deployment, 'cancelled', 'Cancelled');
		}
		return true;
	}

	/* ─────────── auto-deploy ─────────── */

	/** Called once a build's final state (including test ingestion) is persisted. */
	async onBuildFinished(build: Build): Promise<void> {
		if (!build.groupId) return;
		const group = await this.groups.findById(build.projectSlug, build.groupId);
		if (!group || !group.autoDeploy || group.autoDeployStartedAt) return;

		const members: Build[] = [];
		for (const buildId of group.buildIds) {
			const member = await this.builds.findById(build.projectSlug, buildId);
			if (!member) return;
			members.push(member);
		}
		if (members.some(m => m.status === 'pending' || m.status === 'running')) return;

		const project = await this.projects.findBySlug(build.projectSlug);
		if (!project) return;

		// Claim the group before creating anything so a repeated completion event cannot duplicate deployments.
		await this.groups.update(group.projectSlug, group.id, { autoDeployStartedAt: new Date().toISOString() });

		const failed = members.filter(m => m.status !== 'success');
		if (failed.length > 0) {
			console.log(`[deploy] Auto-deploy of group ${group.id} skipped: ${failed.map(m => `${m.platform} ${m.status}`).join(', ')}`);
			this.io.emit('group:auto-deploy-skipped', { projectSlug: group.projectSlug, groupId: group.id, reasons: failed.map(m => `${m.platform}: build ${m.status}`) });
			return;
		}

		for (const member of members) {
			try {
				await this.createDeployment(member, project, {}, 'auto', 'auto-deploy', 'group');
			} catch (err) {
				console.error(`[deploy] Auto-deploy of build ${member.id} failed to start:`, err);
				this.io.emit('group:auto-deploy-skipped', { projectSlug: group.projectSlug, groupId: group.id, reasons: [`${member.platform}: ${(err as Error).message}`] });
			}
		}
	}

	/* ─────────── agent callbacks ─────────── */

	/** Completion from the agent the transfer request went to; any other agent's report is ignored. */
	onAgentFilesSent(event: AgentFilesSentEvent, agentId: string): void {
		const waiting = this.waitingForAgent.get(event.deploymentId);
		if (!waiting || waiting.agentId !== agentId) return;
		this.waitingForAgent.delete(event.deploymentId);
		waiting.resolve(event);
	}

	/**
	 * Validate an incoming upload for a deployment. Returns the absolute destination path, or
	 * throws with a client-facing message. Only the files recorded at the end of the build are
	 * accepted, at the paths they were recorded under.
	 */
	async authorizeUpload(deployment: Deployment, agentTokenId: string, relativePath: string): Promise<string> {
		if (deployment.status !== 'transferring') throw new DeploymentError('Deployment is not accepting uploads');
		if (deployment.agentTokenId !== agentTokenId) throw new DeploymentError('Upload is not from the agent assigned to this deployment');
		const normalized = relativePath.replace(/\\/g, '/');
		if (!normalized || normalized.includes('..') || path.isAbsolute(normalized) || normalized.includes('\0')) throw new DeploymentError('Invalid relative path');
		if (!deployment.files.some(f => f.path === normalized)) throw new DeploymentError(`${normalized} is not one of the build's recorded deploy files`);

		const inputsRoot = this.deployments.inputsDirectory(deployment.projectSlug, deployment.id);
		const target = path.resolve(inputsRoot, normalized);
		if (!target.startsWith(inputsRoot + path.sep)) throw new DeploymentError('Path traversal blocked');
		await fs.mkdir(path.dirname(target), { recursive: true });
		return target;
	}

	/** Log a file the upload route accepted. */
	async onFileReceived(deployment: Deployment, relativePath: string, size: number): Promise<void> {
		await this.appendLog(deployment, `Received ${relativePath} (${formatSize(size)})`);
	}

	/* ─────────── execution ─────────── */

	/** Resolves once every queued deployment run has finished. For shutdown and tests. */
	async settled(): Promise<void> {
		await Promise.all([...this.queues.values()].map(queue => queue.catch(() => undefined)));
	}

	private schedule(deployment: Deployment): void {
		const previous = this.queues.get(deployment.projectSlug) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(() => this.run(deployment.id, deployment.projectSlug));
		this.queues.set(deployment.projectSlug, next);
	}

	private async run(deploymentId: string, projectSlug: string): Promise<void> {
		let deployment = await this.deployments.findById(projectSlug, deploymentId);
		if (!deployment || deployment.status !== 'pending') return;
		if (this.cancelled.has(deploymentId)) { await this.finish(deployment, 'cancelled', 'Cancelled'); return; }

		const build = await this.builds.findById(projectSlug, deployment.buildId);
		const project = await this.projects.findBySlug(projectSlug);
		const configuration = project?.configurations?.find(c => c.id === deployment!.configurationId);
		if (!build || !project || !configuration) {
			await this.finish(deployment, 'failed', 'Build, project or configuration no longer exists');
			return;
		}

		deployment.startedAt = new Date().toISOString();
		await this.appendLog(deployment, `Deployment ${deployment.id} of build #${build.buildNumber} (${build.platform}) started.`);

		try {
			deployment = await this.transferStage(deployment);
			deployment = await this.runStage(deployment, build, project, configuration);
			await this.promoteStage(deployment, project);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const current = await this.deployments.findById(projectSlug, deploymentId);
			if (!current || TERMINAL_STATUSES.includes(current.status)) return;
			if (this.cancelled.has(deploymentId)) {
				await this.appendLog(current, 'Deployment cancelled.', 'warning');
				await this.finish(current, 'cancelled', 'Cancelled');
			} else {
				await this.appendLog(current, message, 'error');
				await this.finish(current, 'failed', message);
			}
		} finally {
			this.cancelled.delete(deploymentId);
			this.sessions.delete(deploymentId);
			// The received files are only needed while the script runs; a retry transfers them again.
			await fs.rm(this.deployments.inputsDirectory(projectSlug, deploymentId), { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** Have the originating agent send the build's deploy files and verify they arrived intact. */
	private async transferStage(deployment: Deployment): Promise<Deployment> {
		const agent = await this.waitForAgent(deployment);
		deployment = (await this.deployments.findById(deployment.projectSlug, deployment.id))!;
		this.ensureNotCancelled(deployment.id);

		deployment.agentTokenId = agent.tokenId;
		deployment.pendingReason = undefined;
		await this.setStatus(deployment, 'transferring');
		const total = deployment.files.reduce((sum, f) => sum + f.size, 0);
		await this.appendLog(deployment, `Requesting ${deployment.files.length} deploy file(s) (${formatSize(total)}) from agent ${agent.info.name}.`);

		const inputsRoot = this.deployments.inputsDirectory(deployment.projectSlug, deployment.id);
		await fs.rm(inputsRoot, { recursive: true, force: true });
		await fs.mkdir(inputsRoot, { recursive: true });

		const completion = new Promise<AgentFilesSentEvent>((resolve, reject) => {
			this.waitingForAgent.set(deployment.id, { resolve, reject, agentId: agent.info.id });
		});
		const timeout = setTimeout(() => {
			const waiting = this.waitingForAgent.get(deployment.id);
			if (waiting) { this.waitingForAgent.delete(deployment.id); waiting.reject(new DeploymentError('Agent did not finish the transfer in time')); }
		}, TRANSFER_TIMEOUT_MS);

		try {
			const sent = this.registry.sendFilesRequest(agent.info.id, {
				deploymentId: deployment.id,
				projectSlug: deployment.projectSlug,
				buildId: deployment.buildId,
				files: deployment.files,
			});
			if (!sent) throw new DeploymentError(`Agent ${agent.info.name} disconnected before the request was sent`);

			const result = await completion;
			if (result.status !== 'success') throw new DeploymentError(result.error ?? `Transfer failed on agent ${agent.info.name}`);

			deployment = (await this.deployments.findById(deployment.projectSlug, deployment.id))!;
			await this.verifyFiles(deployment);
			await this.appendLog(deployment, 'All deploy files received and verified.');
			return deployment;
		} finally {
			clearTimeout(timeout);
			this.waitingForAgent.delete(deployment.id);
		}
	}

	/** Check every recorded file arrived with the size and checksum recorded at the end of the build. */
	private async verifyFiles(deployment: Deployment): Promise<void> {
		const inputsRoot = this.deployments.inputsDirectory(deployment.projectSlug, deployment.id);
		for (const file of deployment.files) {
			const filePath = path.join(inputsRoot, file.path);
			let stat;
			try {
				stat = await fs.stat(filePath);
			} catch {
				throw new DeploymentError(`${file.path} did not arrive from the agent`);
			}
			if (stat.size !== file.size) throw new DeploymentError(`${file.path}: size mismatch (${stat.size} received, ${file.size} recorded)`);
			// The upload route verified the body against the agent's checksum header; a sidecar records the accepted hash.
			const accepted = await fs.readFile(filePath + '.sha256', 'utf-8').catch(() => '');
			if (accepted.trim() !== file.sha256) throw new DeploymentError(`${file.path}: checksum differs from the one recorded at the end of the build`);
			await fs.rm(filePath + '.sha256', { force: true });
		}
	}

	/** Run the build's `deploy.sh` on the orchestrator and collect what it left behind. */
	private async runStage(deployment: Deployment, build: Build, project: Project, configuration: BuildConfiguration): Promise<Deployment> {
		await this.setStatus(deployment, 'running');
		this.ensureNotCancelled(deployment.id);

		const inputsRoot = this.deployments.inputsDirectory(deployment.projectSlug, deployment.id);
		const outputRoot = this.deployments.outputDirectory(deployment.projectSlug, deployment.id);
		const resultsFile = path.join(this.deployments.directory(deployment.projectSlug, deployment.id), 'results.txt');
		await fs.rm(outputRoot, { recursive: true, force: true });
		await fs.mkdir(outputRoot, { recursive: true });
		await fs.rm(resultsFile, { force: true });

		const body = await fs.readFile(path.join(inputsRoot, DEPLOY_SCRIPT_NAME), 'utf-8');
		const settings = this.configService.getConfig().deploy;
		const env: NodeJS.ProcessEnv = {
			...process.env,
			DEPLOYMENT_ID: deployment.id,
			PROJECT_SLUG: project.slug,
			BUILD_ID: build.id,
			BUILD_NUMBER: String(build.buildNumber),
			PLATFORM: build.platform,
			CONFIGURATION_ID: configuration.id,
			CONFIGURATION_NAME: configuration.name,
			BUILD_TYPE: configuration.buildType ?? String(build.config?.buildType ?? ''),
			GIT_URL: project.gitUrl,
			GIT_BRANCH: build.gitBranch,
			GIT_COMMIT: build.gitCommit,
			TARGET_BRANCH: deployment.targetBranch ?? '',
			DEPLOY_DIR: toUnixPath(inputsRoot),
			DEPLOY_OUTPUT_DIR: toUnixPath(outputRoot),
			RESULTS_FILE: toUnixPath(resultsFile),
			...(settings.credentialsFile ? { DEPLOY_CREDENTIALS_FILE: toUnixPath(settings.credentialsFile) } : {}),
			...Object.fromEntries(Object.entries(build.config ?? {}).map(([k, v]) => [k.toUpperCase(), String(v)])),
			...Object.fromEntries(Object.entries(deployment.parameters).map(([k, v]) => [k.toUpperCase(), v])),
		};

		const session = this.newSession(deployment);
		const scriptsDir = path.join(this.deployments.directory(deployment.projectSlug, deployment.id), 'scripts');
		await this.appendLog(deployment, `Running ${DEPLOY_SCRIPT_NAME}...`);
		const result = await session.execute(DEPLOY_SCRIPT_NAME, body, inputsRoot, env, SCRIPT_TIMEOUT_MS);
		await fs.rm(scriptsDir, { recursive: true, force: true });

		deployment = (await this.deployments.findById(deployment.projectSlug, deployment.id))!;
		deployment.results = await readResults(resultsFile);
		deployment.artifacts = await listArtifacts(outputRoot);
		await this.deployments.save(deployment);
		this.emitUpdated(deployment);
		if (deployment.artifacts.length > 0) await this.appendLog(deployment, `Artifacts: ${deployment.artifacts.map(a => a.path).join(', ')}`);

		this.ensureNotCancelled(deployment.id);
		if (result.timedOut) throw new DeploymentError(`${DEPLOY_SCRIPT_NAME} timed out`);
		if (!result.success) throw new DeploymentError(`${DEPLOY_SCRIPT_NAME} failed (exit ${result.exitCode})`);
		return deployment;
	}

	/**
	 * Promote the tested commit, or for group-scoped deployments wait until every member has run
	 * its script and let the last one promote on behalf of all. Skipped without a target branch.
	 */
	private async promoteStage(deployment: Deployment, project: Project): Promise<void> {
		if (!deployment.targetBranch) {
			await this.appendLog(deployment, 'No target branch; skipping promotion.');
			await this.finish(deployment, 'success');
			return;
		}

		await this.setStatus(deployment, 'promoting');
		this.ensureNotCancelled(deployment.id);

		let participants: Deployment[] = [deployment];
		if (deployment.promotionScope === 'group' && deployment.groupId) {
			const group = await this.groups.findById(project.slug, deployment.groupId);
			const waiting = group ? await this.groupPromotionState(group, deployment) : { ready: [deployment], missing: [] };
			if (waiting.missing.length > 0) {
				deployment.pendingReason = `Waiting for ${waiting.missing.join(', ')} to finish before promoting`;
				await this.deployments.save(deployment);
				await this.appendLog(deployment, deployment.pendingReason);
				this.emitUpdated(deployment);
				return;
			}
			participants = waiting.ready;
		}

		const settings = this.configService.getConfig().deploy;
		const credentials = await readGitCredentials(settings.credentialsFile);
		const log = (message: string, level: LogLine['level'] = 'info') => {
			for (const participant of participants) void this.appendLog(participant, message, level);
		};

		try {
			const record = await this.promotion.promote({
				projectSlug: project.slug,
				deploymentId: deployment.id,
				rootName: project.name,
				rootUrl: project.gitUrl,
				rootCommit: deployment.rootCommit,
				buildBranch: deployment.buildBranch,
				targetBranch: deployment.targetBranch,
				credentials,
				log,
			});
			for (const participant of participants) {
				const current = (await this.deployments.findById(participant.projectSlug, participant.id)) ?? participant;
				current.promotion = record;
				current.promotionReused = record.deploymentId !== current.id;
				current.pendingReason = undefined;
				await this.finish(current, 'success');
			}
		} catch (err) {
			const message = err instanceof PromotionError ? err.message : `Promotion failed: ${(err as Error).message}`;
			for (const participant of participants) {
				if (participant.id === deployment.id) continue;
				const current = (await this.deployments.findById(participant.projectSlug, participant.id)) ?? participant;
				await this.appendLog(current, message, 'error');
				await this.finish(current, 'failed', message);
			}
			throw new DeploymentError(message);
		}
	}

	/** Which group members have run their script (latest deployment per build in `promoting`) and which are still missing. */
	private async groupPromotionState(group: BuildGroup, self: Deployment): Promise<{ ready: Deployment[]; missing: string[] }> {
		const ready: Deployment[] = [];
		const missing: string[] = [];
		for (const buildId of group.buildIds) {
			if (buildId === self.buildId) { ready.push(self); continue; }
			const deployments = await this.deployments.listForBuild(group.projectSlug, buildId);
			const latest = deployments.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
			// Only deployments heading for the same branch share a promotion.
			if (latest?.status === 'promoting' && latest.targetBranch === self.targetBranch) ready.push(latest);
			else if (latest?.status === 'success') continue;
			else missing.push(group.platforms[group.buildIds.indexOf(buildId)] ?? buildId);
		}
		return { ready, missing };
	}

	/* ─────────── helpers ─────────── */

	/** Resolve a connected agent by the deployment's agent name, waiting while it is offline. */
	private async waitForAgent(deployment: Deployment): Promise<RegisteredAgent> {
		while (true) {
			this.ensureNotCancelled(deployment.id);
			const agent = this.registry.findByName(deployment.agentName);
			if (agent) return agent;

			const current = (await this.deployments.findById(deployment.projectSlug, deployment.id))!;
			current.pendingReason = `Agent ${deployment.agentName} is offline; waiting for it to reconnect`;
			await this.deployments.save(current);
			await this.appendLog(current, current.pendingReason, 'warning');
			this.emitUpdated(current);

			await new Promise<void>(resume => this.waitingForConnection.set(deployment.id, { agentName: deployment.agentName, resume }));
		}
	}

	private onAgentConnected(agent: RegisteredAgent): void {
		for (const [id, waiting] of this.waitingForConnection) {
			if (waiting.agentName !== agent.info.name) continue;
			this.waitingForConnection.delete(id);
			waiting.resume();
		}
	}

	private onAgentDisconnected(agent: RegisteredAgent): void {
		for (const [id, waiting] of this.waitingForAgent) {
			if (waiting.agentId !== agent.info.id) continue;
			this.waitingForAgent.delete(id);
			waiting.reject(new DeploymentError(`Agent ${agent.info.name} disconnected during the transfer`));
		}
	}

	private ensureNotCancelled(deploymentId: string): void {
		if (this.cancelled.has(deploymentId)) throw new DeploymentError('Cancelled');
	}

	private newSession(deployment: Deployment): ScriptSession {
		const session = new ScriptSession({ scriptsDir: path.join(this.deployments.directory(deployment.projectSlug, deployment.id), 'scripts') });
		session.on('log', lines => {
			void this.deployments.appendLog(deployment.projectSlug, deployment.id, lines.map(l => l.message).join('\n') + '\n');
			this.io.to(`deployment:${deployment.id}`).emit('deployment:log', { deploymentId: deployment.id, lines });
		});
		session.on('phase:start', phase => void this.recordPhase(deployment, phase, 'start'));
		session.on('phase:end', phase => void this.recordPhase(deployment, phase, 'end'));
		this.sessions.set(deployment.id, session);
		return session;
	}

	private async recordPhase(deployment: Deployment, phase: BuildPhase, action: 'start' | 'end'): Promise<void> {
		const current = await this.deployments.findById(deployment.projectSlug, deployment.id);
		if (!current) return;
		const index = current.phases.findIndex(p => p.name === phase.name && p.status === 'running');
		if (action === 'start' && index === -1) current.phases.push(phase);
		else if (index !== -1) current.phases[index] = phase;
		else current.phases.push(phase);
		await this.deployments.save(current);
		this.emitUpdated(current);
	}

	private async setStatus(deployment: Deployment, status: DeploymentStatus): Promise<void> {
		deployment.status = status;
		await this.deployments.save(deployment);
		this.emitUpdated(deployment);
	}

	private async finish(deployment: Deployment, status: 'success' | 'failed' | 'cancelled', error?: string): Promise<void> {
		deployment.status = status;
		deployment.error = error;
		deployment.finishedAt = new Date().toISOString();
		if (deployment.startedAt) deployment.durationMs = new Date(deployment.finishedAt).getTime() - new Date(deployment.startedAt).getTime();
		for (const phase of deployment.phases) {
			if (phase.status !== 'running') continue;
			phase.status = status === 'success' ? 'success' : 'failed';
			phase.finishedAt = deployment.finishedAt;
		}
		await this.deployments.save(deployment);
		this.emitUpdated(deployment);
		this.io.emit('deployment:finished', { projectSlug: deployment.projectSlug, deploymentId: deployment.id, buildId: deployment.buildId, platform: deployment.platform, status, error });
	}

	private async appendLog(deployment: Deployment, message: string, level: LogLine['level'] = 'info'): Promise<void> {
		const prefix = level === 'error' ? '::error::' : level === 'warning' ? '::warning::' : '';
		await this.deployments.appendLog(deployment.projectSlug, deployment.id, `${prefix}${message}\n`);
		const line: LogLine = { timestamp: new Date().toISOString(), level, phase: deployment.status, message, lineNumber: 0 };
		this.io.to(`deployment:${deployment.id}`).emit('deployment:log', { deploymentId: deployment.id, lines: [line] });
	}

	private emitUpdated(deployment: Deployment): void {
		this.io.emit('deployment:updated', { projectSlug: deployment.projectSlug, buildId: deployment.buildId, deployment });
	}
}

/**
 * Validate the submitted deploy parameters against the configuration's schema and return the
 * values `deploy.sh` receives, one per declared parameter. Undeclared keys are dropped.
 */
export function resolveDeployParameters(schema: DeploySchema, submitted: Record<string, string>): Record<string, string> {
	const values: Record<string, string> = {};
	for (const [name, field] of Object.entries(schema)) {
		const raw = submitted[name];
		let value: string;
		if (field.type === 'boolean') {
			value = String(raw === undefined ? Boolean(field.default) : raw === 'true' || raw === '1');
		} else {
			value = (raw ?? (field.default === undefined ? '' : String(field.default))).trim();
			if (!value && field.required) throw new DeploymentError(`${field.label ?? name} is required`);
			if (value && field.type === 'select' && field.options && !field.options.includes(value)) throw new DeploymentError(`${field.label ?? name} must be one of ${field.options.join(', ')}`);
			if (value && field.type === 'string' && field.pattern && !new RegExp(`^(?:${field.pattern})$`).test(value)) throw new DeploymentError(`${field.label ?? name} must match ${field.pattern} (got '${value}')`);
		}
		values[name] = value;
	}
	return values;
}

/** Parse the results file `deploy.sh` wrote: `item<TAB>status<TAB>message` per line. */
async function readResults(resultsFile: string): Promise<DeploymentResult[]> {
	let text: string;
	try {
		text = await fs.readFile(resultsFile, 'utf-8');
	} catch {
		return [];
	}
	return text.split(/\r?\n/).filter(line => line.trim()).map(line => {
		const [item, status, ...rest] = line.split('\t');
		return { item: item ?? '', status: status ?? '', message: rest.join('\t') || undefined };
	});
}

/** Every file under the output directory, as artifacts with forward-slash relative paths. */
async function listArtifacts(outputRoot: string): Promise<DeploymentArtifact[]> {
	const artifacts: DeploymentArtifact[] = [];
	const walk = async (dir: string, prefix: string) => {
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
			else if (entry.isFile()) artifacts.push({ path: relative, size: (await fs.stat(path.join(dir, entry.name))).size });
		}
	};
	await walk(outputRoot, '');
	return artifacts;
}

function formatSize(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
}
