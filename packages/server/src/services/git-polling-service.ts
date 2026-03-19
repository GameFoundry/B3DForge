import { execFile } from 'child_process';
import { Server as SocketServer } from 'socket.io';
import type { PollingStatus, PollingRepositoryStatus, WatchedRepository } from '@banshee-forge/shared';
import { ProjectRepository } from '../repositories/project-repository.js';
import { BuildRepository } from '../repositories/build-repository.js';
import { BuildOrchestrator } from './build-orchestrator.js';

interface PollingState {
  lastPollAt?: string;
  nextPollAt?: string;
  repoStatuses: Map<string, { lastCheckedAt?: string; error?: string }>;
}

export class GitPollingService {
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private pollingStates: Map<string, PollingState> = new Map();

  constructor(
    private projectRepo: ProjectRepository,
    private buildRepo: BuildRepository,
    private orchestrator: BuildOrchestrator,
    private io: SocketServer,
  ) {}

  /** Start polling for all projects with autoBuild enabled */
  async initialize(): Promise<void> {
    const projects = await this.projectRepo.findAll();
    for (const project of projects) {
      if (project.autoBuild && project.watchedRepositories?.length)
        this.startPolling(project.slug, project.pollInterval, project.watchedRepositories);
    }
    console.log(`GitPollingService initialized (${this.timers.size} projects polling)`);
  }

  /** Stop all polling timers */
  stop(): void {
    for (const [slug, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(slug);
    }
    this.pollingStates.clear();
  }

  /** Reconfigure polling for a project (after settings change) */
  async updateProject(slug: string): Promise<void> {
    // Stop existing timer
    this.stopPolling(slug);

    const project = await this.projectRepo.findBySlug(slug);
    if (!project) return;

    if (project.autoBuild && project.watchedRepositories?.length)
      this.startPolling(slug, project.pollInterval, project.watchedRepositories);
  }

  /** Stop polling for a removed project */
  removeProject(slug: string): void {
    this.stopPolling(slug);
    this.pollingStates.delete(slug);
  }

  /** Get current polling status for a project */
  async getStatus(slug: string): Promise<PollingStatus> {
    const project = await this.projectRepo.findBySlug(slug);
    if (!project) {
      return { enabled: false, pollInterval: 300, repositories: [] };
    }

    const state = this.pollingStates.get(slug);
    const repositories: PollingRepositoryStatus[] = (project.watchedRepositories ?? []).map(repo => {
      const repoState = state?.repoStatuses.get(repo.id);
      return {
        id: repo.id,
        name: repo.name,
        gitUrl: repo.gitUrl,
        gitBranch: repo.gitBranch,
        lastCommit: repo.lastCommit,
        lastCheckedAt: repoState?.lastCheckedAt,
        error: repoState?.error,
      };
    });

    return {
      enabled: project.autoBuild,
      pollInterval: project.pollInterval,
      lastPollAt: state?.lastPollAt,
      nextPollAt: state?.nextPollAt,
      repositories,
    };
  }

  /** Force an immediate poll for a project */
  async pollNow(slug: string): Promise<PollingStatus> {
    await this.pollProject(slug);
    return this.getStatus(slug);
  }

  private startPolling(slug: string, pollIntervalSeconds: number, repos: WatchedRepository[]): void {
    // Initialize state
    if (!this.pollingStates.has(slug)) {
      this.pollingStates.set(slug, {
        repoStatuses: new Map(),
      });
    }

    const intervalMs = pollIntervalSeconds * 1000;
    const nextPollAt = new Date(Date.now() + intervalMs).toISOString();

    const state = this.pollingStates.get(slug)!;
    state.nextPollAt = nextPollAt;

    // Schedule first poll
    this.scheduleNextPoll(slug, intervalMs);
    console.log(`Polling started for ${slug} (interval: ${pollIntervalSeconds}s, repos: ${repos.length})`);
  }

  private scheduleNextPoll(slug: string, intervalMs: number): void {
    const timer = setTimeout(async () => {
      await this.pollProject(slug);

      // Schedule next poll if still active
      const project = await this.projectRepo.findBySlug(slug);
      if (project?.autoBuild && project.watchedRepositories?.length) {
        const state = this.pollingStates.get(slug);
        if (state)
          state.nextPollAt = new Date(Date.now() + intervalMs).toISOString();
        this.scheduleNextPoll(slug, intervalMs);
      }
    }, intervalMs);

    this.timers.set(slug, timer);
  }

  private stopPolling(slug: string): void {
    const timer = this.timers.get(slug);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(slug);
    }
  }

  private async pollProject(slug: string): Promise<void> {
    const project = await this.projectRepo.findBySlug(slug);
    if (!project || !project.watchedRepositories?.length) return;

    // Skip if builds are already active for this project
    if (this.orchestrator.hasActiveBuilds(slug)) {
      console.log(`Skipping poll for ${slug}: builds already active`);
      const state = this.pollingStates.get(slug);
      if (state)
        state.lastPollAt = new Date().toISOString();
      return;
    }

    const state: PollingState = this.pollingStates.get(slug) ?? { repoStatuses: new Map() };
    if (!this.pollingStates.has(slug))
      this.pollingStates.set(slug, state);

    state.lastPollAt = new Date().toISOString();

    let hasNewCommits = false;
    const updatedRepos: WatchedRepository[] = [...project.watchedRepositories];

    for (let repoIndex = 0; repoIndex < updatedRepos.length; repoIndex++) {
      const repo = updatedRepos[repoIndex];
      try {
        const remoteCommit = await this.getRemoteHead(repo.gitUrl, repo.gitBranch);
        state.repoStatuses.set(repo.id, {
          lastCheckedAt: new Date().toISOString(),
          error: undefined,
        });

        if (remoteCommit && remoteCommit !== repo.lastCommit) {
          hasNewCommits = true;
          updatedRepos[repoIndex] = { ...repo, lastCommit: remoteCommit };
          console.log(`New commit detected for ${slug}/${repo.name}: ${remoteCommit.slice(0, 7)}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        state.repoStatuses.set(repo.id, {
          lastCheckedAt: new Date().toISOString(),
          error: errorMessage,
        });
        console.error(`Poll error for ${slug}/${repo.name}: ${errorMessage}`);
      }
    }

    // Update watched repositories with new commit SHAs
    if (hasNewCommits) {
      await this.projectRepo.update(slug, { watchedRepositories: updatedRepos });

      // Trigger builds for all configurations with autoBuild enabled
      const autoConfigs = (project.configurations ?? []).filter(c => c.autoBuild);
      for (const config of autoConfigs) {
        try {
          const build = await this.buildRepo.create(slug, {
            configurationId: config.id,
            gitBranch: project.gitBranch,
            config: config.defaultConfig ?? {},
            triggeredBy: 'git-polling',
          }, 'auto', config.name);

          await this.orchestrator.triggerBuild(slug, build.id);
          console.log(`Auto-build triggered for ${slug}/${config.name} (build ${build.id})`);
        } catch (error) {
          console.error(`Failed to trigger auto-build for ${slug}/${config.name}:`, error);
        }
      }
    }

    // Emit status update
    this.io.emit('polling:status', { slug, status: await this.getStatus(slug) });
  }

  private getRemoteHead(gitUrl: string, branch: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      execFile('git', ['ls-remote', gitUrl, `refs/heads/${branch}`], {
        timeout: 30000,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ls-remote failed: ${stderr || error.message}`));
          return;
        }

        const line = stdout.trim();
        if (!line) {
          resolve(null);
          return;
        }

        // Format: "<sha>\trefs/heads/<branch>"
        const sha = line.split('\t')[0];
        resolve(sha || null);
      });
    });
  }
}
