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
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  warningCount: number;
  errorCount: number;
  testSummary?: TestSummary;
}

/** Full build details */
export interface Build extends BuildSummary {
  projectSlug: string;
  phases: BuildPhase[];
  submoduleCommits?: Record<string, string>;
}

/** Build creation input */
export interface CreateBuildInput {
  configurationId?: string;  // Optional: defaults to project's defaultConfigurationId
  gitCommit?: string;        // Optional: defaults to branch HEAD
  gitBranch?: string;        // Optional: defaults to project's gitBranch
  config?: ProjectConfig;    // Optional: defaults to configuration's defaultConfig
  triggeredBy?: string;
}
