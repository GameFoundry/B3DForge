import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Locate the bash the CI scripts run under. On Windows this is Git Bash (the WSL launcher
 * would not see the Windows toolchain); on macOS a Homebrew bash is preferred because the
 * system bash 3.2 lacks the associative arrays the scripts use. Returns a bare `bash` for PATH
 * lookup when no known location exists, or null when an explicit path was given but is missing.
 */
export async function findBashPath(explicitPath?: string): Promise<string | null> {
	if (explicitPath) {
		try {
			await fs.access(explicitPath);
			return explicitPath;
		} catch {
			return null;
		}
	}

	const candidates = IS_WINDOWS
		? [
			'C:\\Program Files\\Git\\bin\\bash.exe',
			'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
			process.env.GIT_BASH_PATH,
		].filter(Boolean) as string[]
		: process.platform === 'darwin'
			? ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash']
			: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];

	for (const candidate of candidates) {
		try { await fs.access(candidate); return candidate; } catch { /* try next */ }
	}
	return 'bash';
}

/** Convert a native path to the form Git Bash expects (`C:\foo` → `/c/foo`). A no-op elsewhere. */
export function toUnixPath(nativePath: string): string {
	if (!IS_WINDOWS) return nativePath;
	return nativePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

export interface BashScriptRun {
	process: ChildProcess;
	/** Resolves with the exit code once the process exited and both output streams ended. */
	result: Promise<{ success: boolean; exitCode: number }>;
	/** Kill the whole process tree. */
	kill(): void;
}

/**
 * Run a bash script with tracing enabled, delivering combined stdout/stderr text to `onOutput`
 * as it arrives. The script is sourced inside a login shell so agent profiles (PATH additions
 * for CMake, toolchains) apply.
 */
export function runBashScript(bashPath: string, scriptPath: string, cwd: string, env: NodeJS.ProcessEnv, onOutput: (text: string) => void): BashScriptRun {
	const child = spawn(bashPath, ['--login', '-c', `set -x; source "${toUnixPath(scriptPath)}"`], {
		cwd,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		shell: false,
		// On POSIX, run in its own process group so the whole tree can be killed at once.
		detached: !IS_WINDOWS,
	});

	let killed = false;
	const result = new Promise<{ success: boolean; exitCode: number }>((resolve) => {
		let stdoutEnded = false;
		let stderrEnded = false;
		let processExited = false;
		let exitCode = 1;

		const maybeResolve = () => {
			if (stdoutEnded && stderrEnded && processExited)
				resolve({ success: exitCode === 0 && !killed, exitCode: killed ? -1 : exitCode });
		};

		child.stdout?.on('data', (data: Buffer) => onOutput(data.toString()));
		child.stdout?.on('end', () => { stdoutEnded = true; maybeResolve(); });
		child.stderr?.on('data', (data: Buffer) => onOutput(data.toString()));
		child.stderr?.on('end', () => { stderrEnded = true; maybeResolve(); });
		child.on('close', (code) => {
			exitCode = code ?? 1;
			processExited = true;
			maybeResolve();
		});
		child.on('error', (error) => {
			onOutput(`Script error: ${error.message}\n`);
			stdoutEnded = true;
			stderrEnded = true;
			processExited = true;
			resolve({ success: false, exitCode: 1 });
		});
	});

	const kill = () => {
		if (killed) return;
		killed = true;
		if (IS_WINDOWS) {
			spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
		} else if (child.pid !== undefined) {
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch {
				try { child.kill('SIGKILL'); } catch { /* already dead */ }
			}
		}
	};

	return { process: child, result, kill };
}
