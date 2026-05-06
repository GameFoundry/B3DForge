import type { AgentPlatform } from './agent.js';

/**
 * Re-exported for convenience: the platform this build configuration targets, or `'any'` for no
 * restriction. Used during build-to-agent matching by `AgentDispatcher`.
 */
export type ConfigurationPlatform = AgentPlatform | 'any';

/** Watched repository for git polling */
export interface WatchedRepository {
  id: string;
  name: string;         // e.g., "Framework", "Editor", "Examples"
  gitUrl: string;
  gitBranch: string;
  lastCommit?: string;  // Last seen commit SHA from polling
}

/** Repository polling status (per-repo detail in API response) */
export interface PollingRepositoryStatus {
  id: string;
  name: string;
  gitUrl: string;
  gitBranch: string;
  lastCommit?: string;
  lastCheckedAt?: string;
  error?: string;
}

/** Polling status for a project */
export interface PollingStatus {
  enabled: boolean;
  pollInterval: number;
  lastPollAt?: string;
  nextPollAt?: string;
  repositories: PollingRepositoryStatus[];
}

/** Configuration schema field types */
export interface ConfigSchemaField {
  type: 'select' | 'boolean' | 'string' | 'number';
  options?: string[];
  default?: string | boolean | number;
  label?: string;
  description?: string;
}

/** Project configuration schema */
export type ConfigSchema = Record<string, ConfigSchemaField>;

/** Project configuration values */
export type ProjectConfig = Record<string, string | boolean | number>;

/** Script source options */
export type ScriptSource = 'repo' | 'local' | 'custom';

/** Script configuration */
export interface ScriptConfig {
  source: ScriptSource;
  repoPath?: string;    // Path in repo (for source='repo')
  customPath?: string;  // Absolute path on system (for source='custom')
  // For source='local', script is stored at data/projects/{slug}/configs/{configId}/build.sh or test.{sh,ps1}
}

/** Build configuration - represents a named set of build/test scripts with custom options */
export interface BuildConfiguration {
  id: string;
  name: string;                      // e.g., "Debug", "Release", "Framework Tests"
  description?: string;

  // Scripts
  buildScript: ScriptConfig;         // Always bash
  testScript?: ScriptConfig;         // Optional, always bash

  /**
   * When true the configuration uses its own fetch script stored at
   * `projects/{slug}/configs/{configId}/fetch.sh`. When false/undefined the
   * configuration inherits the project-level fetch script at
   * `projects/{slug}/fetch.sh`.
   */
  overrideFetchScript?: boolean;

  // Build settings
  buildType?: string;                // e.g., "Debug", "Release", "RelWithDebInfo"

  // Per-build options (shown in trigger modal)
  configSchema?: ConfigSchema;       // Custom options for this config
  defaultConfig?: ProjectConfig;     // Default values

  // Settings
  timeoutMs?: number;                // Override default timeout
  forceCleanBuild?: boolean;         // If true, always wipe workspace before build

  // Agent matching
  /** Required agent platform. Defaults to 'any'. */
  platform?: ConfigurationPlatform;
  /** Labels the agent must have to run this configuration (subset match). Defaults to []. */
  requiredLabels?: string[];

  createdAt: string;
  updatedAt: string;
}

/** Build configuration creation input */
export type CreateConfigurationInput = Omit<BuildConfiguration, 'id' | 'createdAt' | 'updatedAt'>;

/** Build configuration update input */
export type UpdateConfigurationInput = Partial<Omit<BuildConfiguration, 'id' | 'createdAt' | 'updatedAt'>>;

/** Project definition */
export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  gitUrl: string;
  gitBranch: string;

  // Multiple build configurations
  configurations: BuildConfiguration[];
  defaultConfigurationId?: string;   // For quick triggers

  // Automation settings
  autoBuild: boolean;                // Master switch for auto-builds
  pollInterval: number;              // seconds
  watchedRepositories?: WatchedRepository[];  // Repos to poll for changes
  /**
   * Configuration IDs to launch when polling activates a build. When undefined
   * defaults to `[defaultConfigurationId]` (only the default configuration is
   * launched). An empty array disables polling-triggered builds entirely.
   */
  pollingConfigurationIds?: string[];

  // Git state
  lastCommit?: string;
  submoduleCommits?: Record<string, string>;

  // Timestamps
  createdAt: string;
  updatedAt: string;
}

/** Project creation input (without auto-generated fields) */
export type CreateProjectInput = Omit<Project, 'id' | 'createdAt' | 'updatedAt'>;

/** Project update input */
export type UpdateProjectInput = Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>;
