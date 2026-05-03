import { EventEmitter } from 'events';
import type { QueuedBuild, QueueStatus } from '@banshee-forge/shared';

export interface BuildQueueEvents {
	'queue:updated': (status: QueueStatus) => void;
	'queue:enqueued': (job: QueuedBuild) => void;
}

export declare interface BuildQueue {
	on<K extends keyof BuildQueueEvents>(event: K, listener: BuildQueueEvents[K]): this;
	emit<K extends keyof BuildQueueEvents>(event: K, ...args: Parameters<BuildQueueEvents[K]>): boolean;
}

/**
 * Priority queue of pending builds, plus a set of currently-active build IDs.
 *
 * The queue does not pull jobs itself. The dispatcher subscribes to `queue:enqueued`
 * (and to agent-availability events) and decides when to start a build by calling
 * `take(buildId)`, which removes the job from the pending queue and adds it to the
 * active set. When a build finishes, the dispatcher calls `markComplete(buildId)`.
 */
export class BuildQueue extends EventEmitter {
	private queue: QueuedBuild[] = [];
	private activeBuildIds: Set<string> = new Set();
	private paused = false;

	enqueue(buildId: string, projectSlug: string, priority = 0): void {
		const job: QueuedBuild = {
			buildId,
			projectSlug,
			priority,
			queuedAt: new Date().toISOString(),
		};

		// Insert by priority (higher priority first, FIFO within priority)
		const insertIndex = this.queue.findIndex(j => j.priority < priority);
		if (insertIndex === -1) {
			this.queue.push(job);
		} else {
			this.queue.splice(insertIndex, 0, job);
		}

		this.emitQueueUpdate();
		if (!this.paused) this.emit('queue:enqueued', job);
	}

	/** Remove a still-pending build from the queue. Returns true if it was present. */
	dequeue(buildId: string): boolean {
		const index = this.queue.findIndex(j => j.buildId === buildId);
		if (index !== -1) {
			this.queue.splice(index, 1);
			this.emitQueueUpdate();
			return true;
		}
		return false;
	}

	/** Pending jobs in priority order (highest first). */
	getPending(): QueuedBuild[] {
		return [...this.queue];
	}

	/** Move a pending job into the active set. Returns the job that was taken, or null. */
	take(buildId: string): QueuedBuild | null {
		const index = this.queue.findIndex(j => j.buildId === buildId);
		if (index === -1) return null;
		const [job] = this.queue.splice(index, 1);
		this.activeBuildIds.add(buildId);
		this.emitQueueUpdate();
		return job;
	}

	getStatus(): QueueStatus {
		return {
			queue: [...this.queue],
			activeBuildIds: Array.from(this.activeBuildIds),
		};
	}

	isActive(buildId: string): boolean {
		return this.activeBuildIds.has(buildId);
	}

	markComplete(buildId: string): void {
		if (this.activeBuildIds.delete(buildId)) {
			this.emitQueueUpdate();
		}
	}

	/** For recovery: declare a build active without taking it from the pending queue (since it's not there). */
	setActive(buildId: string): void {
		this.activeBuildIds.add(buildId);
		this.emitQueueUpdate();
	}

	/** For recovery: add to queue without firing `queue:enqueued` so the dispatcher waits until `resume()`. */
	addToQueueSilent(job: QueuedBuild): void {
		this.queue.push(job);
		this.queue.sort((a, b) => b.priority - a.priority);
	}

	pause(): void {
		this.paused = true;
	}

	/** Re-emit `queue:enqueued` for every pending job so the dispatcher can pick them up. */
	resume(): void {
		this.paused = false;
		for (const job of this.queue) {
			this.emit('queue:enqueued', job);
		}
	}

	private emitQueueUpdate(): void {
		this.emit('queue:updated', this.getStatus());
	}
}
