import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import path from 'path';
import type { BuildPhase, LogLine, PhaseStatus } from '../types/index.js';
import { parseLine } from '../utils/log-parser.js';
import { findBashPath, runBashScript, type BashScriptRun } from './bash.js';

export interface ScriptSessionEvents {
	'log': (lines: LogLine[]) => void;
	'phase:start': (phase: BuildPhase) => void;
	'phase:end': (phase: BuildPhase) => void;
}

export declare interface ScriptSession {
	on<K extends keyof ScriptSessionEvents>(event: K, listener: ScriptSessionEvents[K]): this;
	emit<K extends keyof ScriptSessionEvents>(event: K, ...args: Parameters<ScriptSessionEvents[K]>): boolean;
}

export interface ScriptSessionOptions {
	/** Directory the script body is written to before execution. */
	scriptsDir: string;
	/** How often buffered log lines are flushed to listeners. */
	logBufferIntervalMs?: number;
	/** Explicit bash path; discovered when omitted. */
	bashPath?: string;
}

export interface ScriptRunResult {
	success: boolean;
	exitCode: number;
	timedOut: boolean;
}

/**
 * Runs one bash script, turning its output into parsed log lines and `::phase::` markers into
 * phase start/end events. Serves the stages that run a single script (deployment prepare and
 * publish); multi-script build execution keeps its own sequencing on top of the same primitives.
 */
export class ScriptSession extends EventEmitter {
	private phases: BuildPhase[] = [];
	private currentPhase: BuildPhase | null = null;
	private lineNumber = 0;
	private logBuffer: LogLine[] = [];
	private flushTimer: NodeJS.Timeout | null = null;
	private run: BashScriptRun | null = null;
	private killed = false;

	constructor(private readonly options: ScriptSessionOptions) {
		super();
	}

	getPhases(): BuildPhase[] { return this.phases.map(p => ({ ...p })); }

	/** Emit a line that did not come from the script itself (e.g. a transfer progress message). */
	log(message: string, level: LogLine['level'] = 'info'): void {
		this.logBuffer.push({
			timestamp: new Date().toISOString(),
			level,
			phase: this.currentPhase?.name ?? 'init',
			message,
			lineNumber: ++this.lineNumber,
		});
	}

	/** Open a phase from outside the script, for work the caller performs between scripts. */
	beginPhase(name: string): void { this.startPhase(name); }
	endPhase(status: PhaseStatus, exitCode?: number): void { this.finishCurrentPhase(status, exitCode); }

	/**
	 * Write the script body and run it. Resolves once the process exited and all output was
	 * delivered; a still-open phase is closed with the script's outcome.
	 */
	async execute(name: string, body: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ScriptRunResult> {
		const bashPath = await findBashPath(this.options.bashPath);
		if (!bashPath) throw new Error(`bash not found at ${this.options.bashPath}`);

		await fs.mkdir(this.options.scriptsDir, { recursive: true });
		const scriptPath = path.join(this.options.scriptsDir, name);
		await fs.writeFile(scriptPath, body, 'utf-8');
		if (process.platform !== 'win32') {
			try { await fs.chmod(scriptPath, 0o755); } catch { /* ignore */ }
		}

		this.flushTimer = setInterval(() => this.flush(), this.options.logBufferIntervalMs ?? 100);
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			this.log(`Script timed out after ${Math.round(timeoutMs / 1000)}s`, 'error');
			this.kill();
		}, timeoutMs);

		try {
			this.run = runBashScript(bashPath, scriptPath, cwd, env, text => this.processOutput(text));
			const { success, exitCode } = await this.run.result;
			if (this.currentPhase?.status === 'running') this.finishCurrentPhase(success ? 'success' : 'failed', exitCode);
			return { success: success && !timedOut, exitCode, timedOut };
		} finally {
			clearTimeout(timeout);
			if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
			this.flush();
			this.run = null;
		}
	}

	kill(): void {
		this.killed = true;
		this.run?.kill();
	}

	get wasKilled(): boolean { return this.killed; }

	private processOutput(text: string): void {
		for (const line of text.split(/\r?\n/)) {
			if (!line) continue;
			this.lineNumber++;
			const result = parseLine(line);
			if (result.phase) {
				if (this.currentPhase?.status === 'running') this.finishCurrentPhase('success');
				this.startPhase(result.phase);
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

	private flush(): void {
		if (this.logBuffer.length === 0) return;
		const lines = this.logBuffer;
		this.logBuffer = [];
		this.emit('log', lines);
	}

	private startPhase(name: string): void {
		if (this.currentPhase?.status === 'running') this.finishCurrentPhase('success');
		const phase: BuildPhase = { name, status: 'running', startedAt: new Date().toISOString() };
		this.currentPhase = phase;
		this.phases.push(phase);
		this.emit('phase:start', { ...phase });
	}

	private finishCurrentPhase(status: PhaseStatus, exitCode?: number): void {
		const phase = this.currentPhase;
		if (!phase || phase.status !== 'running') return;
		phase.status = status;
		phase.finishedAt = new Date().toISOString();
		phase.durationMs = new Date(phase.finishedAt).getTime() - new Date(phase.startedAt!).getTime();
		if (exitCode !== undefined) phase.exitCode = exitCode;
		this.emit('phase:end', { ...phase });
	}
}
