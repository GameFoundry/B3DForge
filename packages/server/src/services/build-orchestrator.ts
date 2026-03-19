import { Server as SocketServer } from 'socket.io';
import path from 'path';
import { promises as fs } from 'fs';
import type { Build, BuildStatus, BuildSummary, LogLine, QueueStatus } from '@banshee-forge/shared';
import { BuildQueue } from './build-queue.js';
import { BuildExecutor, ExecutorConfig } from './build-executor.js';
import { WorkspaceCleanup } from './workspace-cleanup.js';
import { TestResultsService } from './test-results-service.js';
import { BuildRepository } from '../repositories/build-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';

export class BuildOrchestrator {
  private queue: BuildQueue;
  private activeExecutors: Map<string, BuildExecutor> = new Map();
  private activeBuildProjects: Map<string, string> = new Map(); // buildId -> projectSlug
  private cleanup: WorkspaceCleanup;
  private executorConfig: ExecutorConfig;
  private dataPath: string;

  constructor(
    private io: SocketServer,
    private buildRepo: BuildRepository,
    private projectRepo: ProjectRepository,
    private testResultsService: TestResultsService | null,
    config: {
      workspaceRoot: string;
      dataPath: string;
      defaultTimeoutMs?: number;
    },
  ) {
    this.dataPath = config.dataPath;
    this.executorConfig = {
      workspaceRoot: config.workspaceRoot,
      dataPath: config.dataPath,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 60 * 60 * 1000,
      logBufferIntervalMs: 100,
    };

    this.cleanup = new WorkspaceCleanup({
      workspaceRoot: config.workspaceRoot,
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

  /** Check if a project has any pending or running builds */
  hasActiveBuilds(projectSlug: string): boolean {
    const status = this.queue.getStatus();

    // Check queue for pending builds for this project
    if (status.queue.some(job => job.projectSlug === projectSlug))
      return true;

    // Check currently running builds for this project
    for (const [, slug] of this.activeBuildProjects) {
      if (slug === projectSlug) return true;
    }

    return false;
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
      // Step 1: Repair index from detail files
      await this.repairBuildsIndex(project.slug);

      // Step 2: Handle interrupted builds (existing logic)
      const { builds } = await this.buildRepo.findAllForProject(project.slug, 1, 1000);

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

  /**
   * Repairs the builds.json index by scanning individual build.json files.
   * Handles: status mismatches, missing entries, stale entries, incorrect nextBuildNumber.
   */
  private async repairBuildsIndex(projectSlug: string): Promise<void> {
    const buildsPath = path.join(this.dataPath, 'builds', projectSlug, 'builds.json');

    // Read current index
    let indexData: { builds: BuildSummary[]; nextBuildNumber: number };
    try {
      const content = await fs.readFile(buildsPath, 'utf-8');
      indexData = JSON.parse(content);
    } catch {
      indexData = { builds: [], nextBuildNumber: 1 };
    }

    const indexMap = new Map(indexData.builds.map(b => [b.id, b]));

    // Scan build directories
    const buildIds = await this.listBuildDirectories(projectSlug);
    let repaired = 0;
    let maxBuildNumber = indexData.nextBuildNumber - 1;

    for (const buildId of buildIds) {
      let build = await this.buildRepo.findById(projectSlug, buildId);
      if (!build) continue;

      // Repair stale phases in completed builds
      const phasesRepaired = await this.repairBuildPhases(projectSlug, build);
      if (phasesRepaired) {
        // Re-read the build after repair
        build = await this.buildRepo.findById(projectSlug, buildId);
        if (!build) continue;
        repaired++;
      }

      maxBuildNumber = Math.max(maxBuildNumber, build.buildNumber);

      const indexed = indexMap.get(buildId);
      if (!indexed) {
        // Missing from index - add it
        indexData.builds.push(this.buildToSummary(build));
        repaired++;
        console.log(`Added missing build ${buildId} to index for ${projectSlug}`);
      } else if (indexed.status !== build.status || indexed.finishedAt !== build.finishedAt) {
        // Status mismatch - update index from detail
        const idx = indexData.builds.findIndex(b => b.id === buildId);
        if (idx !== -1) {
          indexData.builds[idx] = this.buildToSummary(build);
          repaired++;
          console.log(`Repaired build ${buildId} in ${projectSlug}: ${indexed.status} -> ${build.status}`);
        }
      }
      indexMap.delete(buildId);
    }

    // Remove stale entries (index entries with no matching build directory)
    for (const [staleId] of indexMap) {
      const idx = indexData.builds.findIndex(b => b.id === staleId);
      if (idx !== -1) {
        indexData.builds.splice(idx, 1);
        repaired++;
        console.log(`Removed stale index entry ${staleId} from ${projectSlug}`);
      }
    }

    // Ensure nextBuildNumber is correct
    if (maxBuildNumber >= indexData.nextBuildNumber) {
      indexData.nextBuildNumber = maxBuildNumber + 1;
      repaired++;
    }

    if (repaired > 0) {
      await fs.writeFile(buildsPath, JSON.stringify(indexData, null, 2), 'utf-8');
      console.log(`Repaired ${repaired} index entries for ${projectSlug}`);
    }
  }

  /**
   * Repairs stale phase statuses in completed builds.
   * If a build has terminal status but has phases stuck in 'running', mark them as finished.
   * Returns true if any repairs were made.
   */
  private async repairBuildPhases(projectSlug: string, build: Build): Promise<boolean> {
    // Only repair completed builds
    if (!['success', 'failed', 'cancelled'].includes(build.status)) {
      return false;
    }

    // Check if any phases are stuck in 'running'
    const stalePhases = build.phases.filter(p => p.status === 'running');
    if (stalePhases.length === 0) {
      return false;
    }

    // Determine the status to assign to stale phases based on build status
    const phaseStatus = build.status === 'success' ? 'success' : 'failed';
    const finishedAt = build.finishedAt ?? new Date().toISOString();

    // Fix each stale phase
    for (const phase of stalePhases) {
      phase.status = phaseStatus;
      if (!phase.finishedAt) {
        phase.finishedAt = finishedAt;
        if (phase.startedAt) {
          phase.durationMs = new Date(phase.finishedAt).getTime() - new Date(phase.startedAt).getTime();
        }
      }
    }

    // Save the repaired build
    await this.buildRepo.update(projectSlug, build.id, { phases: build.phases });
    console.log(`Repaired ${stalePhases.length} stale phase(s) in build ${build.id} (${projectSlug})`);

    return true;
  }

  private async listBuildDirectories(projectSlug: string): Promise<string[]> {
    const dirPath = path.join(this.dataPath, 'builds', projectSlug);
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      return [];
    }
  }

  private buildToSummary(build: Build): BuildSummary {
    return {
      id: build.id,
      buildNumber: build.buildNumber,
      status: build.status,
      triggerType: build.triggerType,
      triggeredBy: build.triggeredBy,
      gitCommit: build.gitCommit,
      gitBranch: build.gitBranch,
      config: build.config,
      configurationId: build.configurationId,
      configurationName: build.configurationName,
      cleanBuild: build.cleanBuild,
      startedAt: build.startedAt,
      finishedAt: build.finishedAt,
      durationMs: build.durationMs,
      warningCount: build.warningCount,
      errorCount: build.errorCount,
      testSummary: build.testSummary,
    };
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

    // Emit global notification for auto-triggered builds
    if (build.triggerType === 'auto' || build.triggerType === 'webhook') {
      this.io.emit('build:started', {
        buildId,
        projectSlug,
        projectName: project.name,
        buildNumber: build.buildNumber,
        triggerType: build.triggerType,
        configurationName: build.configurationName,
      });
    }

    // Create executor
    const executor = new BuildExecutor(this.executorConfig);
    this.activeExecutors.set(buildId, executor);
    this.activeBuildProjects.set(buildId, projectSlug);

    // Track pending phase updates for completion barrier
    const pendingPhaseUpdates: Promise<void>[] = [];

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

    executor.on('phase:end', (phase) => {
      // Track this async operation for completion barrier
      const updatePromise = (async () => {
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
      })();
      pendingPhaseUpdates.push(updatePromise);
    });

    executor.on('complete', async (status, _exitCode) => {
      try {
        // Wait for ALL pending phase updates to complete before writing final state
        await Promise.allSettled(pendingPhaseUpdates);

        const finalStatus: BuildStatus = status === 'success' ? 'success' : 'failed';

        // Parse test results from the results directory
        let testSummary = undefined;
        if (this.testResultsService) {
          try {
            const resultsDir = path.join(
              this.dataPath,
              'projects',
              projectSlug,
              'builds',
              buildId,
              'results'
            );

            const testResults = await this.testResultsService.parseAndStoreResults(
              projectSlug,
              buildId,
              resultsDir
            );

            testSummary = this.testResultsService.computeTestSummary(testResults);

            // Emit test results event
            this.io.to(`build:${buildId}`).emit('test_results', {
              buildId,
              summary: testSummary,
            });
          } catch (parseErr) {
            console.log(`No test results found for build ${buildId} (this is normal if no tests ran):`, parseErr);
          }
        }

        // Update build with final state
        const finishedAt = new Date().toISOString();
        const durationMs = build.startedAt
          ? new Date(finishedAt).getTime() - new Date(build.startedAt).getTime()
          : undefined;

        await this.buildRepo.update(projectSlug, buildId, {
          status: finalStatus,
          phases: executor.getPhases(),
          warningCount: executor.getWarningCount(),
          errorCount: executor.getErrorCount(),
          finishedAt,
          durationMs,
          testSummary,
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
            testSummary,
          },
        });

        // Global update for dashboard
        this.io.emit('builds:updated');

        // Global notification with build result details
        this.io.emit('build:finished', {
          buildId,
          projectSlug,
          projectName: project.name,
          buildNumber: build.buildNumber,
          triggerType: build.triggerType,
          configurationName: build.configurationName,
          status: finalStatus,
          durationMs,
          warningCount: executor.getWarningCount(),
          errorCount: executor.getErrorCount(),
          testSummary,
        });

        // Cleanup
        this.activeExecutors.delete(buildId);
        this.activeBuildProjects.delete(buildId);
        this.queue.markComplete(buildId);

        // Trigger workspace cleanup for this project
        this.cleanup.cleanupProject(projectSlug);
      } catch (err) {
        console.error(`Error in complete handler for build ${buildId}:`, err);
        // Try to update status to failed to prevent stuck builds
        try {
          await this.buildRepo.updateStatus(projectSlug, buildId, 'failed');
          this.io.to(`build:${buildId}`).emit('build:complete', {
            buildId,
            status: 'failed',
          });
          this.io.emit('builds:updated');
        } catch (updateErr) {
          console.error(`Failed to update build status for ${buildId}:`, updateErr);
        }
        // Still try to clean up
        this.activeExecutors.delete(buildId);
        this.activeBuildProjects.delete(buildId);
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
        this.activeBuildProjects.delete(buildId);
        this.queue.markComplete(buildId);
      } catch (err) {
        console.error(`Error in error handler for build ${buildId}:`, err);
        // Still try to clean up
        this.activeExecutors.delete(buildId);
        this.activeBuildProjects.delete(buildId);
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
        this.activeBuildProjects.delete(buildId);
      this.queue.markComplete(buildId);
    }
  }

  private emitBuildStatus(buildId: string, status: BuildStatus): void {
    this.io.to(`build:${buildId}`).emit('build:status', { buildId, status });
    this.io.emit('builds:updated');
  }
}
