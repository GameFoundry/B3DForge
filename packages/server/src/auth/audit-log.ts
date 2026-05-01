import { promises as fs } from 'fs';
import path from 'path';
import type { Request } from 'express';

export interface AuditEntry {
	timestamp: string;
	actor: string;
	action: string;
	target?: string;
	details?: Record<string, unknown>;
}

/**
 * Append-only audit log of mutating operations. JSONL format at `{dataPath}/auth/audit.log`.
 */
export class AuditLog {
	private readonly logPath: string;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(dataPath: string) {
		this.logPath = path.join(dataPath, 'auth', 'audit.log');
	}

	append(entry: Omit<AuditEntry, 'timestamp'>): void {
		const fullEntry: AuditEntry = { timestamp: new Date().toISOString(), ...entry };
		// Serialize writes through a single chained promise so we never interleave appends.
		this.writeQueue = this.writeQueue.then(async () => {
			try {
				await fs.mkdir(path.dirname(this.logPath), { recursive: true });
				await fs.appendFile(this.logPath, JSON.stringify(fullEntry) + '\n', 'utf-8');
			} catch (err) {
				console.error('Failed to write audit log entry:', err);
			}
		});
	}

	/** Convenience: derive the actor label ("user:alice" or "agent:my-agent") from a request. */
	static actorOf(req: Request): string {
		if (req.user) return `user:${req.user.username}`;
		if (req.agent) return `agent:${req.agent.name}`;
		return 'anonymous';
	}
}
