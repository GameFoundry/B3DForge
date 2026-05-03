import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { promises as fs } from 'fs';
import type {
	BuildAssignment,
	BuildPhase,
	PhaseStatus,
	LogLine,
	BuildErrorCode,
	ScriptPayload,
	RepositoryCommitInfo,
} from '@banshee-forge/shared';
import { parseLine } from '@banshee-forge/shared';

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
	/** Root directory under which per-project, per-configuration workspaces live. */
	workspaceRoot: string;
	/** Root directory where inline script bodies are written before execution. */
	scriptsRoot: string;
	/** Default build timeout if the configuration doesn't override. */
	defaultTimeoutMs: number;
	/** How often to flush the log buffer to listeners. */
	logBufferIntervalMs: number;
	/** Optional explicit path to bash. On Windows defaults to Git Bash; on POSIX defaults to `bash`. */
	bashPath?: string;
}

const IS_WINDOWS = process.platform === 'win32';

const DEFAULT_CONFIG: ExecutorConfig = {
	workspaceRoot: '',
	scriptsRoot: '',
	defaultTimeoutMs: 60 * 60 * 1000,
	logBufferIntervalMs: 100,
	bashPath: IS_WINDOWS ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash',
};

export class BuildExecutor extends EventEmitter {
	private process: ChildProcess | null = null;
	private currentPhase: BuildPhase | null = null;
	private phases: BuildPhase[] = [];
	private warningCount = 0;
	private errorCount = 0;
	private lineNumber = 0;
	private killed = false;
	private timeoutId: NodeJS.Timeout | null = null;
	private repositoryCommits: RepositoryCommitInfo[] = [];

	private logBuffer: LogLine[] = [];
	private logFlushTimer: NodeJS.Timeout | null = null;

	private config: ExecutorConfig;

	constructor(config: Partial<ExecutorConfig>) {
		super();
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	async execute(assignment: BuildAssignment, timeoutMs?: number): Promise<void> {
		const { build, project, configuration, scripts } = assignment;
		const configId = configuration?.id ?? 'default';

		const workspace = path.join(this.config.workspaceRoot, project.slug, configId);
		// Per-build paths kept on the agent. Artifacts/results aren't transferred in v1.
		const buildLocalDir = path.join(this.config.workspaceRoot, '..', 'builds', build.id);
		const resultsDir = path.join(buildLocalDir, 'results');
		const artifactsDir = path.join(buildLocalDir, 'artifacts');
		const scriptsDir = path.join(this.config.scriptsRoot, build.id);

		const shouldClean = build.cleanBuild || configuration?.forceCleanBuild;

		if (shouldClean) {
			try {
				await fs.access(workspace);
				this.logBuffer.push({
					timestamp: new Date().toISOString(),
					level: 'info',
					phase: 'init',
					message: 'Cleaning workspace for fresh build...',
					lineNumber: ++this.lineNumber,
				});
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
			BUILD_TYPE: configuration?.buildType ?? '',
			CLEAN_BUILD: shouldClean ? '1' : '0',
			WORKSPACE: this.toUnixPath(workspace),
			ARTIFACTS_DIR: this.toUnixPath(artifactsDir),
			RESULTS_DIR: this.toUnixPath(resultsDir),
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

		const bashPath = await this.findBashPath();
		if (!bashPath) {
			this.emit('error', 'EXECUTION_FAILED', IS_WINDOWS
				? 'Git Bash not found. Please install Git for Windows.'
				: 'bash not found in PATH.');
			return;
		}

		// Phase 1: fetch
		this.startPhase('fetch');
		const fetchResult = await this.runBashScript(bashPath, fetchScriptPath, workspace, env);

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
		env.TEST_SCRIPT = testScriptPath ? this.toUnixPath(testScriptPath) : '';

		// Phase 2: build
		const buildResult = await this.runBashScript(bashPath, buildScriptPath, workspace, env);
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
		if (shouldRunTests) {
			this.startPhase('tests');
			const testResult = await this.runBashScript(bashPath, testScriptPath, workspace, env);
			this.finishCurrentPhase(testResult.success ? 'success' : 'failed', testResult.exitCode);
			this.flushLogBuffer();
			this.cleanup();
			if (this.killed) {
				this.emit('complete', 'failed', -1);
			} else {
				this.emit('complete', testResult.success ? 'success' : 'failed', testResult.exitCode);
			}
		} else {
			if (this.currentPhase && this.currentPhase.status === 'running') {
				this.finishCurrentPhase('success', 0);
			}
			this.flushLogBuffer();
			this.cleanup();
			this.emit('complete', 'success', 0);
		}
	}

	kill(): void {
		if (this.process && !this.killed) {
			this.killed = true;
			if (IS_WINDOWS) {
				spawn('taskkill', ['/pid', String(this.process.pid), '/f', '/t'], { windowsHide: true });
			} else if (this.process.pid !== undefined) {
				try {
					// Negative pid = process group; we spawn with detached:true on POSIX so this works.
					process.kill(-this.process.pid, 'SIGKILL');
				} catch {
					try { this.process.kill('SIGKILL'); } catch { /* already dead */ }
				}
			}
		}
	}

	getPhases(): BuildPhase[] { return [...this.phases]; }
	getWarningCount(): number { return this.warningCount; }
	getErrorCount(): number { return this.errorCount; }
	getRepositoryCommits(): RepositoryCommitInfo[] { return [...this.repositoryCommits]; }

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

	private runBashScript(
		bashPath: string,
		scriptPath: string,
		cwd: string,
		env: NodeJS.ProcessEnv,
	): Promise<{ success: boolean; exitCode: number }> {
		return new Promise((resolve) => {
			this.process = spawn(bashPath, [
				'--login',
				'-c',
				`set -x; source "${this.toUnixPath(scriptPath)}"`,
			], {
				cwd,
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				shell: false,
				// On POSIX, run in its own process group so we can SIGKILL the whole tree.
				detached: !IS_WINDOWS,
			});

			let stdoutEnded = false;
			let stderrEnded = false;
			let processExited = false;
			let exitCode = 1;

			const maybeResolve = () => {
				if (stdoutEnded && stderrEnded && processExited) {
					resolve({ success: exitCode === 0, exitCode });
				}
			};

			this.process.stdout?.on('data', (data: Buffer) => this.processOutput(data.toString()));
			this.process.stdout?.on('end', () => { stdoutEnded = true; maybeResolve(); });
			this.process.stderr?.on('data', (data: Buffer) => this.processOutput(data.toString()));
			this.process.stderr?.on('end', () => { stderrEnded = true; maybeResolve(); });

			this.process.on('close', (code) => {
				exitCode = code ?? 1;
				processExited = true;
				maybeResolve();
			});

			this.process.on('error', (error) => {
				this.processOutput(`Script error: ${error.message}\n`);
				stdoutEnded = true;
				stderrEnded = true;
				processExited = true;
				resolve({ success: false, exitCode: 1 });
			});
		});
	}

	private async findBashPath(): Promise<string | null> {
		if (this.config.bashPath) {
			try {
				await fs.access(this.config.bashPath);
				return this.config.bashPath;
			} catch {
				// fall through to candidates
			}
		}

		if (IS_WINDOWS) {
			const candidates = [
				'C:\\Program Files\\Git\\bin\\bash.exe',
				'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
				process.env.GIT_BASH_PATH,
			].filter(Boolean) as string[];

			for (const candidate of candidates) {
				try { await fs.access(candidate); return candidate; } catch { /* try next */ }
			}
			return 'bash';
		}

		// POSIX: prefer absolute, otherwise rely on PATH lookup by spawn.
		for (const candidate of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) {
			try { await fs.access(candidate); return candidate; } catch { /* try next */ }
		}
		return 'bash';
	}

	private toUnixPath(p: string): string {
		if (!IS_WINDOWS) return p;
		return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
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
				});
			}

			await this.captureSubmoduleCommits(workspace, 1);
		} catch (err) {
			console.warn('Failed to capture repository commits:', err);
		}
	}

	private async captureSubmoduleCommits(repoDir: string, depth: number): Promise<void> {
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
				});
				await this.captureSubmoduleCommits(trimmedPath, depth + 1);
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

	private flushLogBuffer(): void {
		if (this.logBuffer.length > 0) {
			this.emit('log', [...this.logBuffer]);
			this.logBuffer = [];
		}
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
