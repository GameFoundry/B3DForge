import { Server as SocketServer } from 'socket.io';
import type { BuildStatus, LogLine, QueueStatus } from '@banshee-forge/shared';
import { BuildQueue } from './build-queue.js';
import { BuildExecutor, ExecutorConfig } from './build-executor.js';
import { WorkspaceCleanup } from './workspace-cleanup.js';
import { BuildRepository } from '../repositories/build-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';

export class BuildOrchestrator {
  private queue: BuildQueue;
  private activeExecutors: Map<string, BuildExecutor> = new Map();
  private cleanup: WorkspaceCleanup;
  private executorConfig: ExecutorConfig;

  constructor(
    private io: SocketServer,
    private buildRepo: BuildRepository,
    private projectRepo: ProjectRepository,
    config: {
      workspaceRoot: string;
      dataPath: string;
      defaultTimeoutMs?: number;
      maxWorkspacesPerProject?: number;
    },
  ) {
    this.executorConfig = {
      workspaceRoot: config.workspaceRoot,
      dataPath: config.dataPath,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 60 * 60 * 1000,
      logBufferIntervalMs: 100,
    };

    this.cleanup = new WorkspaceCleanup({
      workspaceRoot: config.workspaceRoot,
      maxWorkspacesPerProject: config.maxWorkspacesPerProject ?? 5,
    });

    this.queue = new BuildQueue();
    this.setupQueueListeners();
  }

  async initialize(): Promise<void> {
    // Recover pending/running builds from storage
    await this.recoverBuilds();

    // Start periodic cleanup
    this.startCleanupSchedule();
  }

  async triggerBuild(projectSlug: string, buildId: string, priority = 0): Promise<void> {
    this.queue.enqueue(buildId, projectSlug, priority);
  }

  async cancelBuild(buildId: string): Promise<boolean> {
    // Try to remove from queue first
    if (this.queue.dequeue(buildId)) {
      return true;
    }

    // Check if currently executing
    const executor = this.activeExecutors.get(buildId);
    if (executor) {
      executor.kill();
      return true;
    }

    return false;
  }

  getQueueStatus(): QueueStatus {
    return this.queue.getStatus();
  }

  private setupQueueListeners(): void {
    this.queue.on('build:ready', async (job) => {
      await this.startBuild(job.buildId, job.projectSlug);
    });

    this.queue.on('queue:updated', (status) => {
      this.io.emit('queue:updated', status);
    });
  }

  private async recoverBuilds(): Promise<void> {
    const projects = await this.projectRepo.findAll();

    for (const project of projects) {
      const { builds } = await this.buildRepo.findAllForProject(project.slug, 1, 100);

      for (const build of builds) {
        if (build.status === 'running') {
          // Mark as failed (we can't resume a running build)
          await this.buildRepo.updateStatus(project.slug, build.id, 'failed');
          await this.buildRepo.appendLog(
            project.slug,
            build.id,
            '\n\n[Build interrupted: Server was restarted]\n'
          );
        } else if (build.status === 'pending') {
          // Re-queue pending builds
          this.queue.addToQueueSilent({
            buildId: build.id,
            projectSlug: project.slug,
            priority: 0,
            queuedAt: build.startedAt ?? new Date().toISOString(),
          });
        }
      }
    }

    // Resume processing
    this.queue.resume();
  }

  private startCleanupSchedule(): void {
    // Run cleanup every hour
    setInterval(async () => {
      const deleted = await this.cleanup.cleanupAll();
      const total = Object.values(deleted).flat().length;
      if (total > 0) {
        console.log(`Cleaned up ${total} old workspaces`);
      }
    }, 60 * 60 * 1000);
  }

  private async startBuild(buildId: string, projectSlug: string): Promise<void> {
    const build = await this.buildRepo.findById(projectSlug, buildId);
    const project = await this.projectRepo.findBySlug(projectSlug);

    if (!build || !project) {
      this.queue.markComplete(buildId);
      return;
    }

    // Look up the configuration (if configurationId is set)
    const configuration = build.configurationId
      ? project.configurations?.find(c => c.id === build.configurationId)
      : undefined;

    // Update status to running
    await this.buildRepo.updateStatus(projectSlug, buildId, 'running');
    this.emitBuildStatus(buildId, 'running');

    // Create executor
    const executor = new BuildExecutor(this.executorConfig);
    this.activeExecutors.set(buildId, executor);

    // Setup event handlers - all async handlers wrapped in try-catch to prevent crashes
    executor.on('log', async (lines: LogLine[]) => {
      try {
        // Append to log file
        const logText = lines.map(l => l.message).join('\n') + '\n';
        await this.buildRepo.appendLog(projectSlug, buildId, logText);

        // Stream to subscribed clients
        this.io.to(`build:${buildId}`).emit('build:log', {
          buildId,
          lines,
        });

        // Update warning/error counts periodically
        const warningCount = executor.getWarningCount();
        const errorCount = executor.getErrorCount();
        this.io.to(`build:${buildId}`).emit('build:stats', {
          buildId,
          warningCount,
          errorCount,
        });
      } catch (err) {
        console.error(`Error in log handler for build ${buildId}:`, err);
      }
    });

    executor.on('phase:start', async (phase) => {
      try {
        this.io.to(`build:${buildId}`).emit('build:phase', {
          buildId,
          phase,
          action: 'start',
        });

        // Save phases to database so late-joining clients see the current phase
        await this.buildRepo.update(projectSlug, buildId, {
          phases: executor.getPhases(),
        });
      } catch (err) {
        console.error(`Error in phase:start handler for build ${buildId}:`, err);
      }
    });

    executor.on('phase:end', async (phase) => {
      try {
        // Emit socket event FIRST to maintain order with phase:start events
        this.io.to(`build:${buildId}`).emit('build:phase', {
          buildId,
          phase,
          action: 'end',
        });

        // Then update database
        await this.buildRepo.update(projectSlug, buildId, {
          phases: executor.getPhases(),
        });
      } catch (err) {
        console.error(`Error in phase:end handler for build ${buildId}:`, err);
      }
    });

    executor.on('complete', async (status, _exitCode) => {
      try {
        const finalStatus: BuildStatus = status === 'success' ? 'success' : 'failed';

        // Update build with final state
        await this.buildRepo.update(projectSlug, buildId, {
          status: finalStatus,
          phases: executor.getPhases(),
          warningCount: executor.getWarningCount(),
          errorCount: executor.getErrorCount(),
          finishedAt: new Date().toISOString(),
        });

        // Emit completion event
        this.io.to(`build:${buildId}`).emit('build:complete', {
          buildId,
          status: finalStatus,
          summary: {
            durationMs: build.startedAt
              ? Date.now() - new Date(build.startedAt).getTime()
              : 0,
            warningCount: executor.getWarningCount(),
            errorCount: executor.getErrorCount(),
            phases: executor.getPhases(),
          },
        });

        // Global update for dashboard
        this.io.emit('builds:updated');

        // Cleanup
        this.activeExecutors.delete(buildId);
        this.queue.markComplete(buildId);

        // Trigger workspace cleanup for this project
        this.cleanup.cleanupProject(projectSlug);
      } catch (err) {
        console.error(`Error in complete handler for build ${buildId}:`, err);
        // Still try to clean up
        this.activeExecutors.delete(buildId);
        this.queue.markComplete(buildId);
      }
    });

    executor.on('error', async (code, message) => {
      try {
        console.error(`Build ${buildId} error [${code}]:`, message);

        await this.buildRepo.appendLog(projectSlug, buildId, `\n[ERROR: ${code}] ${message}\n`);
        await this.buildRepo.updateStatus(projectSlug, buildId, 'failed');

        this.io.to(`build:${buildId}`).emit('build:error', {
          buildId,
          code,
          message,
        });

        this.emitBuildStatus(buildId, 'failed');
        this.activeExecutors.delete(buildId);
        this.queue.markComplete(buildId);
      } catch (err) {
        console.error(`Error in error handler for build ${buildId}:`, err);
        // Still try to clean up
        this.activeExecutors.delete(buildId);
        this.queue.markComplete(buildId);
      }
    });

    // Start execution
    try {
      await executor.execute(build, project, configuration);
    } catch (error) {
      console.error(`Failed to start build ${buildId}:`, error);
      await this.buildRepo.updateStatus(projectSlug, buildId, 'failed');
      this.emitBuildStatus(buildId, 'failed');
      this.activeExecutors.delete(buildId);
      this.queue.markComplete(buildId);
    }
  }

  private emitBuildStatus(buildId: string, status: BuildStatus): void {
    this.io.to(`build:${buildId}`).emit('build:status', { buildId, status });
    this.io.emit('builds:updated');
  }
}
