import { promises as fs } from 'fs';
import path from 'path';
import type {
	Build,
	BuildConfiguration,
	BuildAssignment,
	Project,
	ScriptConfig,
	ScriptPayload,
} from '@banshee-forge/shared';
import { BuildQueue } from './build-queue.js';
import { AgentRegistry, RegisteredAgent } from './agent-registry.js';
import { BuildRepository } from '../repositories/build-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import { BuildOrchestrator } from './build-orchestrator.js';

export interface DispatcherConfig {
	dataPath: string;
}

interface Assignment {
	buildId: string;
	projectSlug: string;
	agentId: string;
	startedAt: string;
}

/**
 * Coordinates pending builds in the queue with available agents. The queue and registry are
 * passive; this is the only component that decides what runs where.
 *
 * Lifecycle: subscribe to `queue:enqueued` (new work) and `agent:available` (new capacity);
 * both call `tryDispatch()`. Each pending build is matched to an eligible agent (platform +
 * labels + free slot). When an agent reports back (log/phase/complete/error/disconnect),
 * routing happens via the assignments map to the orchestrator's handlers.
 */
export class AgentDispatcher {
	private assignments: Map<string, Assignment> = new Map();
	private dispatching = false;

	constructor(
		private queue: BuildQueue,
		private registry: AgentRegistry,
		private orchestrator: BuildOrchestrator,
		private buildRepo: BuildRepository,
		private projectRepo: ProjectRepository,
		private config: DispatcherConfig,
	) {
		this.queue.on('queue:enqueued', () => { void this.tryDispatch(); });
		this.registry.on('available', () => { void this.tryDispatch(); });
		this.registry.on('disconnected', (agent) => this.handleAgentDisconnect(agent));
	}

	async tryDispatch(): Promise<void> {
		if (this.dispatching) return;
		this.dispatching = true;
		try {
			while (true) {
				const pending = this.queue.getPending();
				if (pending.length === 0) break;

				let dispatchedThisPass = false;
				for (const job of pending) {
					const matched = await this.tryDispatchJob(job.buildId, job.projectSlug);
					if (matched) {
						dispatchedThisPass = true;
						break; // queue mutated; restart scan
					}
				}
				if (!dispatchedThisPass) break;
			}
		} finally {
			this.dispatching = false;
		}
	}

	/** Attempt to dispatch a specific pending build. Returns true if it was assigned to an agent. */
	private async tryDispatchJob(buildId: string, projectSlug: string): Promise<boolean> {
		const build = await this.buildRepo.findById(projectSlug, buildId);
		const project = await this.projectRepo.findBySlug(projectSlug);
		if (!build || !project) {
			// Stale queue entry — discard so it doesn't block.
			this.queue.dequeue(buildId);
			await this.buildRepo.updateStatus(projectSlug, buildId, 'failed').catch(() => undefined);
			return false;
		}

		const configuration = build.configurationId
			? project.configurations?.find(c => c.id === build.configurationId)
			: undefined;

		const platform = configuration?.platform ?? 'any';
		const requiredLabels = configuration?.requiredLabels ?? [];

		const eligible = this.registry.findEligible(platform, requiredLabels);
		if (eligible.length === 0) return false;
		const agent = eligible[0];

		const payload = await this.buildAssignmentPayload(build, project, configuration);
		if (!payload) {
			// Script resolution failed — fail the build rather than blocking the queue.
			this.queue.dequeue(buildId);
			await this.orchestrator.onAgentError(
				{ buildId, code: 'SCRIPT_NOT_FOUND', message: 'Failed to assemble build scripts' },
				projectSlug,
				null,
			);
			return false;
		}

		// Move from pending to active and record the assignment.
		this.queue.take(buildId);
		const assignment: Assignment = {
			buildId,
			projectSlug,
			agentId: agent.info.id,
			startedAt: new Date().toISOString(),
		};
		this.assignments.set(buildId, assignment);
		this.registry.noteAssignment(agent.info.id, buildId);

		// Persist the agent attribution and tell the orchestrator the build is starting.
		await this.buildRepo.update(projectSlug, buildId, {
			agentId: agent.info.id,
			agentName: agent.info.name,
		});
		payload.build.agentId = agent.info.id;
		payload.build.agentName = agent.info.name;

		await this.orchestrator.onBuildAssigned(buildId, projectSlug, agent.info.id, agent.info.name);

		const sent = this.registry.sendAssignment(agent.info.id, payload);
		if (!sent) {
			// Agent vanished between selection and send — fail-safe.
			await this.handleAgentDisconnectForBuild(assignment, 'Agent disconnected before assignment was delivered');
			return false;
		}
		return true;
	}

	cancel(buildId: string): boolean {
		// First try the pending queue.
		if (this.queue.dequeue(buildId)) return true;

		const assignment = this.assignments.get(buildId);
		if (!assignment) return false;
		this.registry.sendCancel(assignment.agentId, { buildId });
		return true;
	}

	getAgentForBuild(buildId: string): string | null {
		return this.assignments.get(buildId)?.agentId ?? null;
	}

	getProjectForBuild(buildId: string): string | null {
		return this.assignments.get(buildId)?.projectSlug ?? null;
	}

	hasActiveBuilds(projectSlug: string): boolean {
		for (const a of this.assignments.values()) {
			if (a.projectSlug === projectSlug) return true;
		}
		for (const job of this.queue.getPending()) {
			if (job.projectSlug === projectSlug) return true;
		}
		return false;
	}

	/** Called by the agent namespace when an agent reports `agent:complete`. */
	finalizeAssignment(buildId: string): void {
		const assignment = this.assignments.get(buildId);
		if (!assignment) return;
		this.assignments.delete(buildId);
		this.registry.noteCompletion(assignment.agentId, buildId);
		this.queue.markComplete(buildId);
	}

	private async handleAgentDisconnect(agent: RegisteredAgent): Promise<void> {
		const orphaned = Array.from(this.assignments.values())
			.filter(a => a.agentId === agent.info.id);
		for (const a of orphaned) {
			await this.handleAgentDisconnectForBuild(a, 'Agent disconnected mid-build');
		}
	}

	private async handleAgentDisconnectForBuild(assignment: Assignment, reason: string): Promise<void> {
		this.assignments.delete(assignment.buildId);
		this.queue.markComplete(assignment.buildId);
		await this.orchestrator.onAgentError(
			{ buildId: assignment.buildId, code: 'EXECUTION_FAILED', message: reason },
			assignment.projectSlug,
			assignment.agentId,
		);
	}

	private async buildAssignmentPayload(
		build: Build,
		project: Project,
		configuration: BuildConfiguration | undefined,
	): Promise<BuildAssignment | null> {
		if (!configuration) return null;

		// Fetch script resolution: per-configuration when `overrideFetchScript`
		// is set, otherwise the shared project-level fetch script.
		const fetchPath = configuration.overrideFetchScript
			? path.join(this.config.dataPath, 'projects', project.slug, 'configs', configuration.id, 'fetch.sh')
			: path.join(this.config.dataPath, 'projects', project.slug, 'fetch.sh');
		const fetch = await this.readToInline(fetchPath);
		if (!fetch || fetch.kind !== 'inline') return null;

		const buildScript = await this.scriptToPayload(
			configuration.buildScript,
			project.slug,
			configuration.id,
			'build.sh',
		);
		if (!buildScript) return null;

		const testScript = configuration.testScript
			? await this.scriptToPayload(
				configuration.testScript,
				project.slug,
				configuration.id,
				'test.sh',
			)
			: undefined;

		return {
			build,
			project,
			configuration,
			scripts: {
				fetch,
				build: buildScript,
				...(testScript ? { test: testScript } : {}),
			},
		};
	}

	private async scriptToPayload(
		config: ScriptConfig,
		projectSlug: string,
		configurationId: string,
		defaultFilename: string,
	): Promise<ScriptPayload | null> {
		switch (config.source) {
			case 'repo': {
				if (!config.repoPath) return null;
				return { kind: 'repo', repoPath: config.repoPath };
			}
			case 'custom': {
				if (!config.customPath) return null;
				return await this.readToInline(config.customPath);
			}
			case 'local':
			default: {
				const localPath = path.join(
					this.config.dataPath,
					'projects',
					projectSlug,
					'configs',
					configurationId,
					defaultFilename,
				);
				return await this.readToInline(localPath);
			}
		}
	}

	private async readToInline(filePath: string): Promise<ScriptPayload | null> {
		try {
			const body = await fs.readFile(filePath, 'utf-8');
			return { kind: 'inline', body };
		} catch {
			return null;
		}
	}
}
