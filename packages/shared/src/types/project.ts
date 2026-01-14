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

/** Script type for test scripts */
export type ScriptType = 'bash' | 'powershell';

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
  testScript?: ScriptConfig;         // Optional
  testScriptType?: ScriptType;       // 'bash' | 'powershell'

  // Build settings
  buildType?: string;                // e.g., "Debug", "Release", "RelWithDebInfo"

  // Per-build options (shown in trigger modal)
  configSchema?: ConfigSchema;       // Custom options for this config
  defaultConfig?: ProjectConfig;     // Default values

  // Settings
  timeoutMs?: number;                // Override default timeout
  autoBuild: boolean;                // Include in auto-builds

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
