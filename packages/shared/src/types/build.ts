import type { ProjectConfig } from './project.js';

/** Build status */
export type BuildStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

/** Build trigger type */
export type TriggerType = 'manual' | 'auto' | 'webhook';

/** Build phase status */
export type PhaseStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

/** Build phase */
export interface BuildPhase {
  name: string;
  status: PhaseStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  warningCount?: number;
  errorCount?: number;
}

/** Test summary */
export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
}

/** Build summary (for list views) */
export interface BuildSummary {
  id: string;
  buildNumber: number;
  status: BuildStatus;
  triggerType: TriggerType;
  triggeredBy?: string;
  gitCommit: string;
  gitBranch: string;
  config: ProjectConfig;
  configurationId: string;           // Which configuration was used
  configurationName: string;         // Denormalized for display
  /** Target platform id (from `platforms.json`). Decides which agents may run the build. */
  platform: string;
  cleanBuild: boolean;               // Whether workspace was wiped before build
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  warningCount: number;
  errorCount: number;
  testSummary?: TestSummary;
  /** ID of the agent that ran (or is running) the build. Set when dispatched. */
  agentId?: string;
  /** Denormalized agent name for display. */
  agentName?: string;
}

/** Commit info for a repository (main repo or submodule) */
export interface RepositoryCommitInfo {
  name: string;
  commit: string;
  commitMessage: string;
  depth: number;  // 0 = main repo, 1 = direct submodule, 2+ = nested
}

/** Full build details */
export interface Build extends BuildSummary {
  projectSlug: string;
  phases: BuildPhase[];
  submoduleCommits?: Record<string, string>;
  repositoryCommits?: RepositoryCommitInfo[];
}

/** Build creation input */
export interface CreateBuildInput {
  configurationId?: string;  // Optional: defaults to project's defaultConfigurationId
  /**
   * Target platforms to build for. One build is created per entry. Optional: defaults to
   * every platform the configuration supports.
   */
  platforms?: string[];
  gitCommit?: string;        // Optional: defaults to branch HEAD
  gitBranch?: string;        // Optional: defaults to project's gitBranch
  config?: ProjectConfig;    // Optional: defaults to configuration's defaultConfig
  triggeredBy?: string;
  cleanBuild?: boolean;      // Optional: force clean workspace (wipe before build)
}

/** Response of the trigger-build endpoint: one build per requested platform. */
export interface TriggerBuildResponse {
  builds: Build[];
}
