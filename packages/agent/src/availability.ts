import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import os from 'os';

export interface Availability {
	available: boolean;
	reason?: string;
}

export interface AvailabilityMonitorEvents {
	'changed': (availability: Availability) => void;
}

export declare interface AvailabilityMonitor {
	on<K extends keyof AvailabilityMonitorEvents>(event: K, listener: AvailabilityMonitorEvents[K]): this;
	emit<K extends keyof AvailabilityMonitorEvents>(event: K, ...args: Parameters<AvailabilityMonitorEvents[K]>): boolean;
}

/**
 * Decides whether this agent should accept new builds right now, and reports flips to the
 * orchestrator via the heartbeat.
 *
 * On macOS a shared laptop is only usable for CI while the agent's own user owns the console:
 * while another user is logged in at the screen (fast user switching) the agent reports itself
 * unavailable and builds stay queued. A closed lid puts the laptop to sleep, which drops the
 * connection entirely, so it needs no special handling here. Other platforms are always
 * available.
 */
export class AvailabilityMonitor extends EventEmitter {
	private current: Availability = { available: true };
	private timer: NodeJS.Timeout | null = null;

	constructor(private pollIntervalMs = 15_000) {
		super();
	}

	get value(): Availability { return this.current; }

	start(): void {
		if (process.platform !== 'darwin') return;
		const tick = () => {
			this.probeDarwin().then(next => {
				if (next.available !== this.current.available || next.reason !== this.current.reason) {
					this.current = next;
					this.emit('changed', next);
				}
			}).catch(err => console.warn('Availability probe failed:', err));
		};
		tick();
		this.timer = setInterval(tick, this.pollIntervalMs);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** Available only when the console (the physical screen) belongs to the agent's user. */
	private async probeDarwin(): Promise<Availability> {
		const owner = await consoleOwner();
		const self = os.userInfo().username;
		if (owner === self) return { available: true };
		if (!owner || owner === 'root') return { available: false, reason: 'no user logged in at console' };
		return { available: false, reason: `console in use by ${owner}` };
	}
}

/** Owner of /dev/console: the user currently logged in at the screen, or root at the login window. */
function consoleOwner(): Promise<string | null> {
	return new Promise((resolve) => {
		execFile('stat', ['-f', '%Su', '/dev/console'], { timeout: 5000 }, (error, stdout) => {
			if (error) { resolve(null); return; }
			resolve(stdout.trim() || null);
		});
	});
}
