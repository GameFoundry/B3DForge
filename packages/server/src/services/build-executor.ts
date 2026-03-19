import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { promises as fs } from 'fs';
import type { Build, Project, BuildPhase, PhaseStatus, LogLine, BuildErrorCode, ScriptConfig, BuildConfiguration, RepositoryCommitInfo } from '@banshee-forge/shared';
import { parseLine } from './log-parser.js';

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
  workspaceRoot: string;
  dataPath: string;
  defaultTimeoutMs: number;
  logBufferIntervalMs: number;
  gitBashPath?: string;  // Path to Git Bash executable
}

const DEFAULT_CONFIG: ExecutorConfig = {
  workspaceRoot: '',
  dataPath: '',
  defaultTimeoutMs: 60 * 60 * 1000, // 1 hour
  logBufferIntervalMs: 100,         // Flush logs every 100ms
  gitBashPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
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

  // Log buffering
  private logBuffer: LogLine[] = [];
  private logFlushTimer: NodeJS.Timeout | null = null;

  private config: ExecutorConfig;

  constructor(config: Partial<ExecutorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async execute(build: Build, project: Project, configuration?: BuildConfiguration, timeoutMs?: number): Promise<void> {
    // Workspace is per-configuration (not per-build) to enable incremental builds
    const configId = configuration?.id ?? 'default';
    const workspace = path.join(this.config.workspaceRoot, project.slug, configId);

    // Results and artifacts are per-build (stored in data directory, not workspace)
    const buildDataDir = path.join(this.config.dataPath, 'projects', project.slug, 'builds', build.id);
    const resultsDir = path.join(buildDataDir, 'results');
    const artifactsDir = path.join(buildDataDir, 'artifacts');

    // Determine if we need a clean build
    const shouldClean = build.cleanBuild || configuration?.forceCleanBuild;

    // Clean workspace if requested
    if (shouldClean) {
      try {
        await fs.access(workspace);
        // Workspace exists, clean it
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

    // Create directories
    try {
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(resultsDir, { recursive: true });
      await fs.mkdir(artifactsDir, { recursive: true });
    } catch (err) {
      this.emit('error', 'WORKSPACE_ERROR', `Failed to create workspace: ${err}`);
      return;
    }

    // Resolve fetch script path (required, always bash, always local)
    const fetchScriptPath = await this.resolveFetchScript(project, configuration);
    if (!fetchScriptPath) {
      this.emit('error', 'SCRIPT_NOT_FOUND', `Fetch script not found for project ${project.slug}`);
      return;
    }

    // Resolve build script path (required, always bash)
    const buildScriptPath = await this.resolveBuildScript(project, configuration, workspace);
    if (!buildScriptPath) {
      this.emit('error', 'SCRIPT_NOT_FOUND', `Build script not found for project ${project.slug}`);
      return;
    }

    // Resolve test script path (optional, always bash)
    const testScriptPath = await this.resolveTestScript(project, configuration, workspace);

    // Build environment variables
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // System variables
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
      // Pass test script info to build script
      TEST_SCRIPT: testScriptPath ? this.toUnixPath(testScriptPath) : '',
      // User-configured variables from build config
      ...Object.fromEntries(
        Object.entries(build.config).map(([k, v]) => [k.toUpperCase(), String(v)])
      ),
    };

    // Set timeout
    const timeout = timeoutMs ?? this.config.defaultTimeoutMs;
    this.timeoutId = setTimeout(() => {
      this.emit('error', 'TIMEOUT', `Build timed out after ${timeout / 1000}s`);
      this.kill();
    }, timeout);

    // Start log flush timer
    this.logFlushTimer = setInterval(() => this.flushLogBuffer(), this.config.logBufferIntervalMs);

    // Find bash path
    const bashPath = await this.findBashPath();
    if (!bashPath) {
      this.emit('error', 'EXECUTION_FAILED', 'Git Bash not found. Please install Git for Windows.');
      return;
    }

    // Phase 1: Run fetch script
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

    // Capture commit info from workspace after successful fetch
    await this.captureRepositoryCommits(workspace, project);

    // Run build script - phases are defined by script output (e.g., [configure], [build])
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

    // Run test script if configured and runTests is enabled
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
      // Ensure last phase is marked complete before emitting completion
      if (this.currentPhase && this.currentPhase.status === 'running') {
        this.finishCurrentPhase('success', 0);
      }
      this.flushLogBuffer();
      this.cleanup();
      this.emit('complete', 'success', 0);
    }
  }

  /**
   * Run a bash script and return the result.
   * Waits for both stdout/stderr streams to end AND process to exit before resolving.
   * This prevents race conditions where the process exits before all output is processed.
   */
  private runBashScript(
    bashPath: string,
    scriptPath: string,
    cwd: string,
    env: NodeJS.ProcessEnv
  ): Promise<{ success: boolean; exitCode: number }> {
    return new Promise((resolve) => {
      // Inject set -x to enable xtrace (prints commands before execution)
      // Commands will appear in output prefixed with '+ '
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
      });

      // Track completion of streams and process to avoid race conditions
      let stdoutEnded = false;
      let stderrEnded = false;
      let processExited = false;
      let exitCode = 1;

      const maybeResolve = () => {
        if (stdoutEnded && stderrEnded && processExited) {
          resolve({ success: exitCode === 0, exitCode });
        }
      };

      this.process.stdout?.on('data', (data: Buffer) => {
        this.processOutput(data.toString());
      });

      this.process.stdout?.on('end', () => {
        stdoutEnded = true;
        maybeResolve();
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        this.processOutput(data.toString());
      });

      this.process.stderr?.on('end', () => {
        stderrEnded = true;
        maybeResolve();
      });

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

  /**
   * Execute a test script separately (always bash)
   */
  async executeTestScript(
    project: Project,
    configuration: BuildConfiguration | undefined,
    workspace: string,
    env: NodeJS.ProcessEnv
  ): Promise<{ success: boolean; exitCode: number }> {
    const testScriptPath = await this.resolveTestScript(project, configuration, workspace);
    if (!testScriptPath) {
      return { success: true, exitCode: 0 }; // No test script is OK
    }

    return new Promise((resolve) => {
      // Bash - inject set -x to enable xtrace (prints commands before execution)
      const bashPath = this.config.gitBashPath ?? 'bash';
      const testProcess = spawn(bashPath, [
        '--login',
        '-c',
        `set -x; source "${this.toUnixPath(testScriptPath)}"`,
      ], {
        cwd: workspace,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });

      testProcess.stdout?.on('data', (data: Buffer) => {
        this.processOutput(data.toString());
      });

      testProcess.stderr?.on('data', (data: Buffer) => {
        this.processOutput(data.toString());
      });

      testProcess.on('close', (code) => {
        resolve({ success: code === 0, exitCode: code ?? 1 });
      });

      testProcess.on('error', (error) => {
        this.processOutput(`Test script error: ${error.message}\n`);
        resolve({ success: false, exitCode: 1 });
      });
    });
  }

  kill(): void {
    if (this.process && !this.killed) {
      this.killed = true;
      // On Windows, kill the process tree
      spawn('taskkill', ['/pid', String(this.process.pid), '/f', '/t'], {
        windowsHide: true,
      });
    }
  }

  getPhases(): BuildPhase[] {
    return [...this.phases];
  }

  getWarningCount(): number {
    return this.warningCount;
  }

  getErrorCount(): number {
    return this.errorCount;
  }

  getRepositoryCommits(): RepositoryCommitInfo[] {
    return [...this.repositoryCommits];
  }

  private async findBashPath(): Promise<string | null> {
    // Check configured path
    if (this.config.gitBashPath) {
      try {
        await fs.access(this.config.gitBashPath);
        return this.config.gitBashPath;
      } catch {
        // Continue to check alternatives
      }
    }

    // Common Git Bash locations on Windows
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      process.env.GIT_BASH_PATH,
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // Try next
      }
    }

    // Try just 'bash' in case it's in PATH
    return 'bash';
  }

  private toUnixPath(windowsPath: string): string {
    // Convert Windows path to Unix-style for Git Bash
    // C:\foo\bar -> /c/foo/bar
    return windowsPath
      .replace(/\\/g, '/')
      .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  }

  private async resolveFetchScript(project: Project, configuration: BuildConfiguration | undefined): Promise<string | null> {
    if (!configuration) return null;

    // Fetch script is always local - stored at data/projects/{slug}/configs/{configId}/fetch.sh
    const scriptPath = path.join(
      this.config.dataPath,
      'projects',
      project.slug,
      'configs',
      configuration.id,
      'fetch.sh'
    );

    try {
      await fs.access(scriptPath);
      return scriptPath;
    } catch {
      return null;
    }
  }

  private async resolveBuildScript(project: Project, configuration: BuildConfiguration | undefined, workspace: string): Promise<string | null> {
    if (!configuration) return null;

    return this.resolveScriptConfig(
      configuration.buildScript,
      project.slug,
      workspace,
      'build.sh',
      configuration.id
    );
  }

  private async resolveTestScript(project: Project, configuration: BuildConfiguration | undefined, workspace: string): Promise<string | null> {
    if (!configuration || !configuration.testScript) return null;

    return this.resolveScriptConfig(
      configuration.testScript,
      project.slug,
      workspace,
      'test.sh',
      configuration.id
    );
  }

  private async resolveScriptConfig(
    config: ScriptConfig,
    projectSlug: string,
    workspace: string,
    defaultFilename: string,
    configurationId: string
  ): Promise<string | null> {
    switch (config.source) {
      case 'repo':
        if (config.repoPath) {
          const repoPath = path.join(workspace, config.repoPath);
          try {
            await fs.access(repoPath);
            return repoPath;
          } catch {
            // Fall through to local
          }
        }
        break;

      case 'custom':
        if (config.customPath) {
          try {
            await fs.access(config.customPath);
            return config.customPath;
          } catch {
            return null;
          }
        }
        break;

      case 'local':
      default: {
        // Local script in data directory
        const scriptDir = path.join(this.config.dataPath, 'projects', projectSlug, 'configs', configurationId);
        const localPath = path.join(scriptDir, defaultFilename);
        try {
          await fs.access(localPath);
          return localPath;
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  /**
   * Capture commit hash and message for the main repo and all submodules
   * (recursively) directly from the workspace after fetch.
   */
  private async captureRepositoryCommits(workspace: string, project: Project): Promise<void> {
    try {
      // Main repo
      const mainCommit = await this.execGit(workspace, ['rev-parse', 'HEAD']);
      const mainMessage = await this.execGit(workspace, ['log', '-1', '--format=%s']);

      if (mainCommit) {
        this.repositoryCommits.push({
          name: project.name ?? 'Main',
          commit: mainCommit.trim(),
          commitMessage: mainMessage?.trim() ?? '',
          depth: 0,
        });
      }

      // Recursively walk submodules
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

        // Recurse into this submodule's submodules
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
      proc.on('close', (code) => {
        resolve(code === 0 ? stdout : null);
      });
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
    // Defensive: should not start a phase while another is running
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
