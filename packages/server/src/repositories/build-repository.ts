import type { Build, BuildSummary, CreateBuildInput, BuildStatus, TriggerType } from '@banshee-forge/shared';
import { generateBuildId } from '@banshee-forge/shared';
import { JsonFileStorage } from '../storage/json-file.js';

interface BuildsFile {
  builds: BuildSummary[];
  nextBuildNumber: number;
}

export class BuildRepository {
  constructor(private storage: JsonFileStorage) {}

  private buildsFilePath(projectSlug: string): string {
    return `builds/${projectSlug}/builds.json`;
  }

  private buildFilePath(projectSlug: string, buildId: string): string {
    return `builds/${projectSlug}/${buildId}/build.json`;
  }

  async findAllForProject(projectSlug: string, page = 1, pageSize = 20): Promise<{ builds: BuildSummary[]; total: number }> {
    const data = await this.storage.read<BuildsFile>(this.buildsFilePath(projectSlug), {
      builds: [],
      nextBuildNumber: 1
    });

    // Sort by build number descending (newest first)
    const sorted = [...data.builds].sort((a, b) => b.buildNumber - a.buildNumber);
    const start = (page - 1) * pageSize;
    const builds = sorted.slice(start, start + pageSize);

    return { builds, total: data.builds.length };
  }

  async findById(projectSlug: string, buildId: string): Promise<Build | null> {
    const build = await this.storage.read<Build | null>(this.buildFilePath(projectSlug, buildId), null);
    return build;
  }

  async create(
    projectSlug: string,
    input: CreateBuildInput,
    triggerType: TriggerType,
    configurationName = 'default'
  ): Promise<Build> {
    const buildsPath = this.buildsFilePath(projectSlug);
    const data = await this.storage.read<BuildsFile>(buildsPath, { builds: [], nextBuildNumber: 1 });

    const buildNumber = data.nextBuildNumber;
    const buildId = generateBuildId();
    const now = new Date().toISOString();

    const build: Build = {
      id: buildId,
      projectSlug,
      buildNumber,
      status: 'pending',
      triggerType,
      triggeredBy: input.triggeredBy,
      gitCommit: input.gitCommit ?? '',
      gitBranch: input.gitBranch ?? '',
      config: input.config ?? {},
      configurationId: input.configurationId ?? '',
      configurationName,
      cleanBuild: input.cleanBuild ?? false,
      warningCount: 0,
      errorCount: 0,
      phases: [],
      startedAt: now,
    };

    // Update builds list
    const summary: BuildSummary = {
      id: buildId,
      buildNumber,
      status: 'pending',
      triggerType,
      triggeredBy: input.triggeredBy,
      gitCommit: input.gitCommit ?? '',
      gitBranch: input.gitBranch ?? '',
      config: input.config ?? {},
      configurationId: input.configurationId ?? '',
      configurationName,
      cleanBuild: input.cleanBuild ?? false,
      warningCount: 0,
      errorCount: 0,
      startedAt: now,
    };

    data.builds.push(summary);
    data.nextBuildNumber = buildNumber + 1;

    await this.storage.write<BuildsFile>(buildsPath, data);
    await this.storage.write<Build>(this.buildFilePath(projectSlug, buildId), build);

    return build;
  }

  async updateStatus(projectSlug: string, buildId: string, status: BuildStatus): Promise<Build | null> {
    const updates: Partial<Build> = { status };

    if (status === 'running') {
      // Will be handled by updateAtomic - only set startedAt if not already set
    }

    return this.updateAtomic(projectSlug, buildId, updates);
  }

  async update(projectSlug: string, buildId: string, updates: Partial<Build>): Promise<Build | null> {
    return this.updateAtomic(projectSlug, buildId, updates);
  }

  /**
   * Updates a build atomically, ensuring detail and index files remain consistent.
   * Write order: detail (build.json) first, then index (builds.json).
   * Recovery can always reconstruct index from detail files.
   */
  private async updateAtomic(projectSlug: string, buildId: string, updates: Partial<Build>): Promise<Build | null> {
    const buildPath = this.buildFilePath(projectSlug, buildId);
    const buildsPath = this.buildsFilePath(projectSlug);

    // Read current state
    const build = await this.storage.read<Build | null>(buildPath, null);
    if (!build) return null;

    const buildsData = await this.storage.read<BuildsFile>(buildsPath, { builds: [], nextBuildNumber: 1 });

    // Apply updates
    Object.assign(build, updates);

    // Handle running status - set startedAt if not already set
    if (updates.status === 'running' && !build.startedAt) {
      build.startedAt = new Date().toISOString();
    }

    // Compute derived fields if status changed to terminal
    if (updates.status && ['success', 'failed', 'cancelled'].includes(updates.status)) {
      if (!build.finishedAt) {
        build.finishedAt = new Date().toISOString();
      }
      if (build.startedAt && !build.durationMs) {
        build.durationMs = new Date(build.finishedAt).getTime() - new Date(build.startedAt).getTime();
      }
    }

    // CRITICAL: Write detail file FIRST (source of truth)
    await this.storage.write<Build>(buildPath, build);

    // THEN update index (can be reconstructed from detail if this fails)
    const index = buildsData.builds.findIndex(b => b.id === build.id);
    if (index !== -1) {
      buildsData.builds[index] = this.buildToSummary(build);
      await this.storage.write<BuildsFile>(buildsPath, buildsData);
    }

    return build;
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

  async getLog(projectSlug: string, buildId: string): Promise<string | null> {
    return this.storage.readText(`builds/${projectSlug}/${buildId}/log.txt`);
  }

  async appendLog(projectSlug: string, buildId: string, content: string): Promise<void> {
    const logPath = `builds/${projectSlug}/${buildId}/log.txt`;
    const existing = await this.storage.readText(logPath) ?? '';
    await this.storage.writeText(logPath, existing + content);
  }
}
