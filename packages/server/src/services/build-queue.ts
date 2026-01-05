import { EventEmitter } from 'events';
import type { QueuedBuild, QueueStatus } from '@banshee-forge/shared';

export interface BuildQueueEvents {
  'build:ready': (job: QueuedBuild) => void;
  'queue:updated': (status: QueueStatus) => void;
}

export declare interface BuildQueue {
  on<K extends keyof BuildQueueEvents>(event: K, listener: BuildQueueEvents[K]): this;
  emit<K extends keyof BuildQueueEvents>(event: K, ...args: Parameters<BuildQueueEvents[K]>): boolean;
}

export class BuildQueue extends EventEmitter {
  private queue: QueuedBuild[] = [];
  private activeBuildId: string | null = null;
  private paused = false;

  enqueue(buildId: string, projectSlug: string, priority = 0): void {
    const job: QueuedBuild = {
      buildId,
      projectSlug,
      priority,
      queuedAt: new Date().toISOString(),
    };

    // Insert by priority (higher priority first)
    const insertIndex = this.queue.findIndex(j => j.priority < priority);
    if (insertIndex === -1) {
      this.queue.push(job);
    } else {
      this.queue.splice(insertIndex, 0, job);
    }

    this.emitQueueUpdate();
    this.processNext();
  }

  dequeue(buildId: string): boolean {
    const index = this.queue.findIndex(j => j.buildId === buildId);
    if (index !== -1) {
      this.queue.splice(index, 1);
      this.emitQueueUpdate();
      return true;
    }
    return false;
  }

  getStatus(): QueueStatus {
    return {
      queue: [...this.queue],
      activeBuildId: this.activeBuildId,
    };
  }

  isActive(buildId: string): boolean {
    return this.activeBuildId === buildId;
  }

  markComplete(buildId: string): void {
    if (this.activeBuildId === buildId) {
      this.activeBuildId = null;
      this.emitQueueUpdate();
      this.processNext();
    }
  }

  // For recovery: set active build without triggering processing
  setActive(buildId: string): void {
    this.activeBuildId = buildId;
    this.emitQueueUpdate();
  }

  // For recovery: add to queue without triggering processing
  addToQueueSilent(job: QueuedBuild): void {
    this.queue.push(job);
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.processNext();
  }

  private processNext(): void {
    if (this.paused || this.activeBuildId !== null || this.queue.length === 0) {
      return;
    }

    const next = this.queue.shift()!;
    this.activeBuildId = next.buildId;
    this.emit('build:ready', next);
    this.emitQueueUpdate();
  }

  private emitQueueUpdate(): void {
    this.emit('queue:updated', this.getStatus());
  }
}
