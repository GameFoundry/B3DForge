import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { promises as fs } from 'fs';
import type {
	BuildAssignment,
	BuildDeploymentInputs,
	BuildPhase,
	PhaseStatus,
	LogLine,
	BuildErrorCode,
	ScriptPayload,
	RepositoryCommitInfo,
} from '@banshee-forge/shared';
import { parseLine } from '@banshee-forge/shared';
import { findBashPath, runBashScript, toUnixPath, type BashScriptRun } from '@banshee-forge/shared/node';
import { collectDeploymentInputs, DEPLOY_DIR_NAME } from './deployment-inputs.js';
import { resolveWorkspace, WorkspaceLocks } from './workspace.js';

export interface ExecutorEvents {
	'log': (lines: LogLine[]) => void;
	'phase:start': (phase: BuildPhase) => void;
	'phase:end': (phase: BuildPhase) => void;
	'complete': (status: 'success' | 'failed', exitCode: number) => void;
	'error': (code: BuildErrorCode, message: string) => void;
}

export declare interface BuildExecutor {
	on<K extends keyof ExecutorEvents>(event: K, listener: ExecutorEvents[K]): this;
	emit<K extends keyof ExecutorEvents>(event: K, ...args: Parameters<ExecutorEvents[K]>): boolean;
}

export interface ExecutorConfig {
	/** Root directory under which per-project, per-configuration, per-platform workspaces live. */
	workspaceRoot: string;
	/**
	 * Root directory holding the per-build `results`/`artifacts`/`deploy` directories. Defaults to
	 * a `builds` sibling of {@link workspaceRoot}. Shared with {@link ArtifactStore}, which purges
	 * the artifact trees, so the two must agree on the layout.
	 */
	buildsRoot: string;
	/** Root directory where inline script bodies are written before execution. */
	scriptsRoot: string;
	/** Default build timeout if the configuration doesn't override. */
	defaultTimeoutMs: number;
	/** How often to flush the log buffer to listeners. */
	logBufferIntervalMs: number;
	/**
	 * Maximum serialized size (bytes) of a single emitted log batch. Batches are
	 * split so that no single `agent:log` Socket.IO message approaches the
	 * transport's `maxHttpBufferSize` (1 MB by default) — exceeding that limit
	 * makes the server drop the agent connection mid-build.
	 */
	maxLogBatchBytes: number;
	/** Maximum size (bytes) of a single log line's message before it is truncated. */
	maxLogLineBytes: number;
	/**
	 * Optional explicit path to bash. On Windows defaults to Git Bash; on macOS to Homebrew bash
	 * when installed (system bash 3.2 cannot run the CI scripts); elsewhere to `bash`.
	 */
	bashPath?: string;
}

const IS_WINDOWS = process.platform === 'win32';

/**
 * Approximate serialized overhead (bytes) of a `LogLine`'s non-message fields
 * (timestamp, level, phase, lineNumber, JSON punctuation). Added to each line's
 * message length when sizing a batch so the estimate stays conservative.
 */
const LOG_LINE_OVERHEAD_BYTES = 256;

const DEFAULT_CONFIG: ExecutorConfig = {
	workspaceRoot: '',
	buildsRoot: '',
	scriptsRoot: '',
	defaultTimeoutMs: 60 * 60 * 1000,
	logBufferIntervalMs: 100,
	maxLogBatchBytes: 512 * 1024,
	maxLogLineBytes: 128 * 1024,
	bashPath: undefined,
};

export class BuildExecutor extends EventEmitter {
	private run: BashScriptRun | null = null;
	private currentPhase: BuildPhase | null = null;
	private phases: BuildPhase[] = [];
	private warningCount = 0;
	private errorCount = 0;
	private lineNumber = 0;
	private killed = false;
	private timeoutId: NodeJS.Timeout | null = null;
	private repositoryCommits: RepositoryCommitInfo[] = [];
	private resultsDir: string | null = null;
	private snapshotCategories: string[] = [];
	private deploymentInputs: BuildDeploymentInputs | null = null;
	private releaseWorkspace: (() => void) | null = null;

	private logBuffer: LogLine[] = [];
	private logFlushTimer: NodeJS.Timeout | null = null;

	private config: ExecutorConfig;

	constructor(config: Partial<ExecutorConfig>) {
		super();
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	async execute(assignment: BuildAssignment, timeoutMs?: number): Promise<void> {
		try {
			await this.executeInner(assignment, timeoutMs);
		} finally {
			this.releaseWorkspace?.();
			this.releaseWorkspace = null;
		}
	}

	private async executeInner(assignment: BuildAssignment, timeoutMs?: number): Promise<void> {
		const { build, project, configuration, scripts } = assignment;
		const configId = configuration?.id ?? 'default';
		const platform = build.platform ?? process.platform;

		// Per-build paths kept on the agent. Test results are uploaded to the orchestrator at end
		// of build so they appear in the build detail UI; artifacts and deploy files stay local
		// until a deployment asks for them.
		const buildsRoot = this.config.buildsRoot || path.resolve(this.config.workspaceRoot, '..', 'builds');
		const buildLocalDir = path.join(buildsRoot, build.id);
		const resultsDir = path.join(buildLocalDir, 'results');
		const artifactsDir = path.join(buildLocalDir, 'artifacts');
		const deployDir = path.join(buildLocalDir, DEPLOY_DIR_NAME);
		const scriptsDir = path.join(this.config.scriptsRoot, build.id);
		this.resultsDir = resultsDir;

		let workspace: string;
		try {
			workspace = await resolveWorkspace(this.config.workspaceRoot, project.slug, configId, platform);
		} catch (err) {
			this.emit('error', 'WORKSPACE_ERROR', `Failed to resolve workspace: ${err}`);
			return;
		}

		// Two builds of the same configuration and platform share one incremental workspace, so
		// they must not run in it at the same time. The second one waits for the first to finish.
		if (WorkspaceLocks.isHeld(workspace)) {
			this.logBuffer.push(this.infoLine(`Waiting for another build to leave workspace ${workspace}...`));
		}
		this.releaseWorkspace = await WorkspaceLocks.acquire(workspace);
		if (this.killed) {
			this.emit('complete', 'failed', -1);
			return;
		}

		const shouldClean = build.cleanBuild || configuration?.forceCleanBuild;

		if (shouldClean) {
			try {
				await fs.access(workspace);
				this.logBuffer.push(this.infoLine('Cleaning workspace for fresh build...'));
				await fs.rm(workspace, { recursive: true, force: true });
			} catch {
				// Workspace doesn't exist, nothing to clean
			}
		}

		try {
			await fs.mkdir(workspace, { recursive: true });
			await fs.mkdir(resultsDir, { recursive: true });
			await fs.mkdir(artifactsDir, { recursive: true });
			await fs.mkdir(scriptsDir, { recursive: true });
			// Inputs from a previous run of this build id (a retry) must not leak into this one.
			await fs.rm(deployDir, { recursive: true, force: true });
			await fs.mkdir(deployDir, { recursive: true });
		} catch (err) {
			this.emit('error', 'WORKSPACE_ERROR', `Failed to create workspace: ${err}`);
			return;
		}

		// The fetch script must always be inline — we don't have a workspace yet to read from.
		if (scripts.fetch.kind !== 'inline') {
			this.emit('error', 'SCRIPT_NOT_FOUND', 'Fetch script must be delivered inline');
			return;
		}
		const fetchScriptPath = await this.writeInlineScript(scriptsDir, 'fetch.sh', scripts.fetch.body);

		const env: NodeJS.ProcessEnv = {
			...process.env,
			GIT_URL: project.gitUrl,
			GIT_BRANCH: build.gitBranch,
			GIT_COMMIT: build.gitCommit,
			GIT_COMMIT_SHORT: build.gitCommit.substring(0, 7),
			BUILD_NUMBER: String(build.buildNumber),
			BUILD_ID: build.id,
			CONFIGURATION_ID: configuration?.id ?? '',
			CONFIGURATION_NAME: configuration?.name ?? 'default',
			// Target platform the build is for (win32/darwin/linux/ps5) versus the OS running the
			// scripts. Scripts branch on PLATFORM; HOST_PLATFORM matters when they differ (e.g. ps5).
			PLATFORM: platform,
			HOST_PLATFORM: process.platform,
			ARCH: process.arch,
			BUILD_TYPE: configuration?.buildType ?? '',
			CLEAN_BUILD: shouldClean ? '1' : '0',
			WORKSPACE: toUnixPath(workspace),
			ARTIFACTS_DIR: toUnixPath(artifactsDir),
			RESULTS_DIR: toUnixPath(resultsDir),
			DEPLOY_DIR: toUnixPath(deployDir),
			...Object.fromEntries(
				Object.entries(build.config).map(([k, v]) => [k.toUpperCase(), String(v)])
			),
		};

		const timeout = timeoutMs ?? configuration?.timeoutMs ?? this.config.defaultTimeoutMs;
		this.timeoutId = setTimeout(() => {
			this.emit('error', 'TIMEOUT', `Build timed out after ${timeout / 1000}s`);
			this.kill();
		}, timeout);

		this.logFlushTimer = setInterval(() => this.flushLogBuffer(), this.config.logBufferIntervalMs);

		const bashPath = await findBashPath(this.config.bashPath);
		if (!bashPath) {
			this.cleanup();
			this.emit('error', 'EXECUTION_FAILED', IS_WINDOWS
				? 'Git Bash not found. Please install Git for Windows.'
				: 'bash not found in PATH.');
			return;
		}

		// Phase 1: fetch
		this.startPhase('fetch');
		const fetchResult = await this.runScript(bashPath, fetchScriptPath, workspace, env);

		if (this.killed) {
			this.cleanup();
			this.finishCurrentPhase('failed', -1);
			this.flushLogBuffer();
			this.emit('complete', 'failed', -1);
			return;
		}

		if (!fetchResult.success) {
			this.cleanup();
			this.finishCurrentPhase('failed', fetchResult.exitCode);
			this.flushLogBuffer();
			this.emit('complete', 'failed', fetchResult.exitCode);
			return;
		}

		this.finishCurrentPhase('success', 0);
		await this.captureRepositoryCommits(workspace, project.name);

		// Resolve build/test scripts — for repo-sourced scripts the fetch must have completed first.
		const buildScriptPath = await this.resolveScript(scripts.build, scriptsDir, 'build.sh', workspace);
		if (!buildScriptPath) {
			this.emit('error', 'SCRIPT_NOT_FOUND', 'Build script not found');
			this.cleanup();
			return;
		}

		const testScriptPath = scripts.test
			? await this.resolveScript(scripts.test, scriptsDir, 'test.sh', workspace)
			: null;
		env.TEST_SCRIPT = testScriptPath ? toUnixPath(testScriptPath) : '';

		// Phase 2: build
		const buildResult = await this.runScript(bashPath, buildScriptPath, workspace, env);
		this.finishCurrentPhase(buildResult.success ? 'success' : 'failed', buildResult.exitCode);
		this.flushLogBuffer();

		if (this.killed) {
			this.cleanup();
			this.emit('complete', 'failed', -1);
			return;
		}

		if (!buildResult.success) {
			this.cleanup();
			this.emit('complete', 'failed', buildResult.exitCode);
			return;
		}

		// Phase 3 (optional): tests
		const shouldRunTests = build.config.runTests && testScriptPath;
		let status: 'success' | 'failed' = 'success';
		let exitCode = 0;
		if (shouldRunTests) {
			this.startPhase('tests');
			const testResult = await this.runScript(bashPath, testScriptPath, workspace, env);
			this.finishCurrentPhase(testResult.success ? 'success' : 'failed', testResult.exitCode);
			this.flushLogBuffer();
			if (this.killed) {
				this.cleanup();
				this.emit('complete', 'failed', -1);
				return;
			}
			status = testResult.success ? 'success' : 'failed';
			exitCode = testResult.exitCode;
		} else if (this.currentPhase && this.currentPhase.status === 'running') {
			this.finishCurrentPhase('success', 0);
		}

		// Record what the build left in its deploy directory. Hashing happens here, once, so the
		// orchestrator can verify the files when a deployment transfers them.
		if (status === 'success') {
			try {
				this.deploymentInputs = await collectDeploymentInputs(buildLocalDir);
				if (this.deploymentInputs) {
					const total = this.deploymentInputs.files.reduce((sum, f) => sum + f.size, 0);
					this.logBuffer.push(this.infoLine(`Deploy files recorded: ${this.deploymentInputs.files.length} file(s), ${(total / 1024 ** 2).toFixed(1)} MiB.`));
				} else {
					this.logBuffer.push(this.infoLine('No deploy files recorded (build script left the deploy directory empty).'));
				}
			} catch (err) {
				this.logBuffer.push(this.infoLine(`Failed to record deployment inputs: ${err}`, 'warning'));
			}
		}

		this.flushLogBuffer();
		this.cleanup();
		this.emit('complete', status, exitCode);
	}

	kill(): void {
		if (!this.killed) {
			this.killed = true;
			this.run?.kill();
		}
	}

	getPhases(): BuildPhase[] { return [...this.phases]; }
	getWarningCount(): number { return this.warningCount; }
	getErrorCount(): number { return this.errorCount; }
	getRepositoryCommits(): RepositoryCommitInfo[] { return [...this.repositoryCommits]; }
	getResultsDir(): string | null { return this.resultsDir; }
	/** Snapshot categories declared via `::snapshot-category::` markers, in emission order. */
	getSnapshotCategories(): string[] { return [...this.snapshotCategories]; }
	/** Deploy files a deployment can draw on; null when the build script left none. */
	getDeploymentInputs(): BuildDeploymentInputs | null { return this.deploymentInputs; }

	private infoLine(message: string, level: LogLine['level'] = 'info'): LogLine {
		return {
			timestamp: new Date().toISOString(),
			level,
			phase: this.currentPhase?.name ?? 'init',
			message,
			lineNumber: ++this.lineNumber,
		};
	}

	private async writeInlineScript(scriptsDir: string, name: string, body: string): Promise<string> {
		const filePath = path.join(scriptsDir, name);
		await fs.writeFile(filePath, body, 'utf-8');
		// Best-effort chmod on POSIX so bash can read it without permission complaints.
		if (!IS_WINDOWS) {
			try { await fs.chmod(filePath, 0o755); } catch { /* ignore */ }
		}
		return filePath;
	}

	private async resolveScript(
		payload: ScriptPayload,
		scriptsDir: string,
		defaultName: string,
		workspace: string,
	): Promise<string | null> {
		if (payload.kind === 'inline') {
			return this.writeInlineScript(scriptsDir, defaultName, payload.body);
		}
		// kind === 'repo' — read from the cloned workspace.
		const scriptPath = path.join(workspace, payload.repoPath);
		try {
			await fs.access(scriptPath);
			return scriptPath;
		} catch {
			return null;
		}
	}

	private async runScript(
		bashPath: string,
		scriptPath: string,
		cwd: string,
		env: NodeJS.ProcessEnv,
	): Promise<{ success: boolean; exitCode: number }> {
		this.run = runBashScript(bashPath, scriptPath, cwd, env, text => this.processOutput(text));
		try {
			return await this.run.result;
		} finally {
			this.run = null;
		}
	}

	private async captureRepositoryCommits(workspace: string, projectName: string): Promise<void> {
		try {
			const mainCommit = await this.execGit(workspace, ['rev-parse', 'HEAD']);
			const mainMessage = await this.execGit(workspace, ['log', '-1', '--format=%s']);

			if (mainCommit) {
				this.repositoryCommits.push({
					name: projectName ?? 'Main',
					commit: mainCommit.trim(),
					commitMessage: mainMessage?.trim() ?? '',
					depth: 0,
					path: '',
				});
			}

			await this.captureSubmoduleCommits(workspace, workspace, 1);
		} catch (err) {
			console.warn('Failed to capture repository commits:', err);
		}
	}

	private async captureSubmoduleCommits(workspace: string, repoDir: string, depth: number): Promise<void> {
		const output = await this.execGit(repoDir, [
			'submodule', 'foreach', '--quiet',
			'echo "$name||$toplevel/$sm_path"',
		]);

		if (!output) return;

		for (const line of output.trim().split('\n').filter(Boolean)) {
			const [name, subPath] = line.split('||');
			if (!name || !subPath) continue;

			const trimmedPath = subPath.trim();
			const subCommit = await this.execGit(trimmedPath, ['rev-parse', 'HEAD']);
			const subMessage = await this.execGit(trimmedPath, ['log', '-1', '--format=%s']);

			if (subCommit) {
				this.repositoryCommits.push({
					name: name.trim(),
					commit: subCommit.trim(),
					commitMessage: subMessage?.trim() ?? '',
					depth,
					// Paths are workspace-relative with forward slashes; git prints the toplevel
					// in native form on Windows, so normalize before comparing.
					path: workspaceRelativePath(workspace, trimmedPath),
				});
				await this.captureSubmoduleCommits(workspace, trimmedPath, depth + 1);
			}
		}
	}

	private execGit(cwd: string, args: string[]): Promise<string | null> {
		return new Promise((resolve) => {
			const proc = spawn('git', args, {
				cwd,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				shell: false,
			});

			let stdout = '';
			proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
			proc.on('close', (code) => resolve(code === 0 ? stdout : null));
			proc.on('error', () => resolve(null));
		});
	}

	private processOutput(data: string): void {
		const lines = data.split(/\r?\n/);

		for (const line of lines) {
			if (!line) continue;

			this.lineNumber++;
			const result = parseLine(line);

			if (result.phase) {
				this.finishCurrentPhase('success');
				this.startPhase(result.phase);
			}

			if (result.snapshotCategory && !this.snapshotCategories.includes(result.snapshotCategory)) {
				this.snapshotCategories.push(result.snapshotCategory);
			}

			if (result.level === 'warning') {
				this.warningCount++;
			} else if (result.level === 'error') {
				this.errorCount++;
			}

			this.logBuffer.push({
				timestamp: new Date().toISOString(),
				level: result.level,
				phase: this.currentPhase?.name ?? 'init',
				message: result.message,
				lineNumber: this.lineNumber,
			});
		}
	}

	/**
	 * Flush buffered log lines to listeners in size-bounded batches. A single
	 * `agent:log` Socket.IO message must stay well under the transport's
	 * `maxHttpBufferSize` (1 MB by default); a larger message causes the server
	 * to drop the agent connection, which surfaces as a spurious "Agent
	 * disconnected mid-build". Oversized individual lines are truncated first so
	 * one runaway line can't exceed the limit on its own.
	 */
	private flushLogBuffer(): void {
		if (this.logBuffer.length === 0) return;

		const pending = this.logBuffer;
		this.logBuffer = [];

		const maxBatchBytes = this.config.maxLogBatchBytes;
		let batch: LogLine[] = [];
		let batchBytes = 0;

		for (const line of pending) {
			const safeLine = this.clampLogLine(line);
			const lineBytes = Buffer.byteLength(safeLine.message, 'utf8') + LOG_LINE_OVERHEAD_BYTES;

			// Emit the accumulated batch before it would exceed the cap. A single
			// (already clamped) line always fits in a batch on its own.
			if (batch.length > 0 && batchBytes + lineBytes > maxBatchBytes) {
				this.emit('log', batch);
				batch = [];
				batchBytes = 0;
			}

			batch.push(safeLine);
			batchBytes += lineBytes;
		}

		if (batch.length > 0)
			this.emit('log', batch);
	}

	/**
	 * Truncate a log line whose message exceeds `maxLogLineBytes`, so a single
	 * runaway line (e.g. a multi-megabyte blob printed without newlines) can't by
	 * itself exceed the transport message-size limit.
	 */
	private clampLogLine(line: LogLine): LogLine {
		const max = this.config.maxLogLineBytes;
		const buf = Buffer.from(line.message, 'utf8');
		if (buf.length <= max) return line;

		const kept = buf.subarray(0, max).toString('utf8');
		const omitted = buf.length - max;
		return {
			...line,
			message: `${kept} …[truncated ${omitted} more bytes]`,
		};
	}

	private startPhase(name: string): void {
		if (this.currentPhase && this.currentPhase.status === 'running') {
			console.warn(`Starting phase '${name}' while '${this.currentPhase.name}' is still running - auto-finishing`);
			this.finishCurrentPhase('success');
		}

		const phase: BuildPhase = {
			name,
			status: 'running',
			startedAt: new Date().toISOString(),
			warningCount: 0,
			errorCount: 0,
		};
		this.currentPhase = phase;
		this.phases.push(phase);
		this.emit('phase:start', phase);
	}

	private finishCurrentPhase(status: PhaseStatus, exitCode?: number): void {
		if (!this.currentPhase) {
			console.warn('finishCurrentPhase called with no current phase');
			return;
		}

		if (this.currentPhase.status !== 'running') {
			console.warn(`finishCurrentPhase called but phase '${this.currentPhase.name}' is already ${this.currentPhase.status}`);
			return;
		}

		this.currentPhase.status = status;
		this.currentPhase.finishedAt = new Date().toISOString();
		this.currentPhase.durationMs =
			new Date(this.currentPhase.finishedAt).getTime() -
			new Date(this.currentPhase.startedAt!).getTime();

		if (exitCode !== undefined) {
			this.currentPhase.exitCode = exitCode;
		}

		this.emit('phase:end', { ...this.currentPhase });
	}

	private cleanup(): void {
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
			this.timeoutId = null;
		}
		if (this.logFlushTimer) {
			clearInterval(this.logFlushTimer);
			this.logFlushTimer = null;
		}
	}
}

/** `target` relative to `workspace`, with forward slashes, tolerant of drive-letter case and MSYS paths. */
function workspaceRelativePath(workspace: string, target: string): string {
	const normalizedTarget = IS_WINDOWS ? fromMsysPath(target) : target;
	const relative = path.relative(path.resolve(workspace), path.resolve(normalizedTarget));
	return relative.split(path.sep).join('/');
}

/** Git Bash prints `/c/foo` style paths from `submodule foreach`; map them back to `C:\foo`. */
function fromMsysPath(p: string): string {
	const match = /^\/([A-Za-z])\/(.*)$/.exec(p);
	return match ? `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}` : p;
}
