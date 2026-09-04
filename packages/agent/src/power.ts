import { spawn, ChildProcess } from 'child_process';

/**
 * Holds a system-sleep assertion while builds run, so a macOS laptop with a closed lid finishes
 * the build instead of sleeping mid-way. Implemented as a `caffeinate` child process, which
 * releases the assertion automatically if the agent dies. `-s` only applies on AC power: on
 * battery the OS is allowed to sleep regardless. No-op on other platforms.
 */
export class SleepInhibitor {
	private process: ChildProcess | null = null;

	acquire(): void {
		if (process.platform !== 'darwin' || this.process) return;
		try {
			this.process = spawn('caffeinate', ['-s', '-i'], { stdio: 'ignore' });
			this.process.on('exit', () => { this.process = null; });
			this.process.on('error', (err) => {
				console.warn('caffeinate failed, builds may be interrupted by sleep:', err.message);
				this.process = null;
			});
		} catch (err) {
			console.warn('Failed to start caffeinate:', err);
			this.process = null;
		}
	}

	release(): void {
		if (!this.process) return;
		try { this.process.kill(); } catch { /* already gone */ }
		this.process = null;
	}
}
