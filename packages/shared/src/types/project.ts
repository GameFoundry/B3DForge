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

/** A parameter `deploy.sh` accepts, entered in the Deploy panel and passed as an environment variable. */
export interface DeploySchemaField {
  type: 'string' | 'boolean' | 'select';
  options?: string[];
  default?: string | boolean;
  label?: string;
  description?: string;
  /** Regular expression (without delimiters) a string value must match when it is not blank. */
  pattern?: string;
  /** When true a blank value blocks the deployment. */
  required?: boolean;
}

/** Deploy parameters of a configuration, keyed by the environment variable name. */
export type DeploySchema = Record<string, DeploySchemaField>;

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
  /**
   * Optional git branch override for this configuration. When unset, builds use
   * the project-level `gitBranch`.
   */
  gitBranch?: string;

  // Per-build options (shown in trigger modal)
  configSchema?: ConfigSchema;       // Custom options for this config
  defaultConfig?: ProjectConfig;     // Default values

  /**
   * Parameters the Deploy panel asks for and passes to the build's `deploy.sh` as uppercased
   * environment variables (e.g. `FRAMEWORK_VERSION`). Empty when the script needs none.
   */
  deploySchema?: DeploySchema;

  // Settings
  timeoutMs?: number;                // Override default timeout
  forceCleanBuild?: boolean;         // If true, always wipe workspace before build

  // Agent matching
  /**
   * Target platforms (ids from `platforms.json`) this configuration can be built for.
   * Undefined or empty means every known platform. Each triggered build picks one of these.
   */
  platforms?: string[];
  /** Labels the agent must have to run this configuration (subset match). Defaults to []. */
  requiredLabels?: string[];

  createdAt: string;
  updatedAt: string;
}

/** Build configuration creation input */
export type CreateConfigurationInput = Omit<BuildConfiguration, 'id' | 'createdAt' | 'updatedAt'>;

/** Build configuration update input */
export type UpdateConfigurationInput = Partial<Omit<BuildConfiguration, 'id' | 'createdAt' | 'updatedAt'>>;

/** A configuration plus the platforms polling should build it for. */
export interface PollingTarget {
  configurationId: string;
  platforms: string[];
}

/** Project definition */
export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  gitUrl: string;
  /** Branch builds are made from. Submodules are built at the commits the root commit pins. */
  gitBranch: string;
  /**
   * Default promotion target offered when deploying a build. Blank disables promotion by
   * default. Defaults to {@link DEFAULT_DEPLOY_BRANCH} for new projects.
   */
  deployBranch?: string;

  // Multiple build configurations
  configurations: BuildConfiguration[];
  defaultConfigurationId?: string;   // For quick triggers

  // Automation settings
  autoBuild: boolean;                // Master switch for auto-builds
  pollInterval: number;              // seconds
  watchedRepositories?: WatchedRepository[];  // Repos to poll for changes
  /**
   * Builds to launch when polling detects new commits: one build per listed
   * platform of each configuration. When undefined defaults to the default
   * configuration on {@link DEFAULT_PLATFORM}. An empty array disables
   * polling-triggered builds entirely.
   */
  pollingTargets?: PollingTarget[];

  // Git state
  lastCommit?: string;
  submoduleCommits?: Record<string, string>;

  // Timestamps
  createdAt: string;
  updatedAt: string;
}

/** Branch deployments promote to when a project does not name one. */
export const DEFAULT_DEPLOY_BRANCH = 'master';

/** Branch new projects build from when none is given. */
export const DEFAULT_STAGING_BRANCH = 'staging';

/** Project creation input (without auto-generated fields) */
export type CreateProjectInput = Omit<Project, 'id' | 'createdAt' | 'updatedAt'>;

/** Project update input */
export type UpdateProjectInput = Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>;
