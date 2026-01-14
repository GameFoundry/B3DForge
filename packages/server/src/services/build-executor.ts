import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { promises as fs } from 'fs';
import type { Build, Project, BuildPhase, PhaseStatus, LogLine, BuildErrorCode, ScriptConfig, BuildConfiguration } from '@banshee-forge/shared';
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

  // Log buffering
  private logBuffer: LogLine[] = [];
  private logFlushTimer: NodeJS.Timeout | null = null;

  private config: ExecutorConfig;

  constructor(config: Partial<ExecutorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async execute(build: Build, project: Project, configuration?: BuildConfiguration, timeoutMs?: number): Promise<void> {
    const workspace = path.join(this.config.workspaceRoot, project.slug, build.id);
    const resultsDir = path.join(workspace, 'results');
    const artifactsDir = path.join(workspace, 'artifacts');

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

    // Resolve test script path (optional, bash or PowerShell)
    const testScriptPath = await this.resolveTestScript(project, configuration, workspace);
    const testScriptType = configuration?.testScriptType ?? 'bash';

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
      WORKSPACE: this.toUnixPath(workspace),
      ARTIFACTS_DIR: this.toUnixPath(artifactsDir),
      RESULTS_DIR: this.toUnixPath(resultsDir),
      // Pass test script info to build script
      TEST_SCRIPT: testScriptPath ? this.toUnixPath(testScriptPath) : '',
      TEST_SCRIPT_TYPE: testScriptType,
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

    // Run build script - phases are defined by script output (e.g., [configure], [build])
    const buildResult = await this.runBashScript(bashPath, buildScriptPath, workspace, env);

    this.cleanup();
    this.finishCurrentPhase(buildResult.success ? 'success' : 'failed', buildResult.exitCode);
    this.flushLogBuffer();

    if (this.killed) {
      this.emit('complete', 'failed', -1);
    } else {
      this.emit('complete', buildResult.success ? 'success' : 'failed', buildResult.exitCode);
    }
  }

  /**
   * Run a bash script and return the result
   */
  private runBashScript(
    bashPath: string,
    scriptPath: string,
    cwd: string,
    env: NodeJS.ProcessEnv
  ): Promise<{ success: boolean; exitCode: number }> {
    return new Promise((resolve) => {
      this.process = spawn(bashPath, [
        '--login',
        '-c',
        `"${this.toUnixPath(scriptPath)}"`,
      ], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.processOutput(data.toString());
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        this.processOutput(data.toString());
      });

      this.process.on('close', (code) => {
        resolve({ success: code === 0, exitCode: code ?? 1 });
      });

      this.process.on('error', (error) => {
        this.processOutput(`Script error: ${error.message}\n`);
        resolve({ success: false, exitCode: 1 });
      });
    });
  }

  /**
   * Execute a test script separately (bash or PowerShell)
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

    const scriptType = configuration?.testScriptType ?? 'bash';

    return new Promise((resolve) => {
      let testProcess: ChildProcess;

      if (scriptType === 'powershell') {
        testProcess = spawn('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-File', testScriptPath,
        ], {
          cwd: workspace,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } else {
        // Bash
        const bashPath = this.config.gitBashPath ?? 'bash';
        testProcess = spawn(bashPath, [
          '--login',
          '-c',
          `"${this.toUnixPath(testScriptPath)}"`,
        ], {
          cwd: workspace,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        });
      }

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

    const ext = configuration.testScriptType === 'powershell' ? 'ps1' : 'sh';
    return this.resolveScriptConfig(
      configuration.testScript,
      project.slug,
      workspace,
      `test.${ext}`,
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
    if (!this.currentPhase) return;

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
