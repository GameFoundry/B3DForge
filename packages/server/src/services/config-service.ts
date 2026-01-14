import fs from 'fs/promises';
import path from 'path';
import type { ServerConfig, ServerConfigUpdate, ConfigSource, ConfigValidationResponse } from '@banshee-forge/shared';

const CONFIG_FILENAME = 'config.json';
const DEFAULT_PORT = 3003;

interface LoadedConfig {
  config: ServerConfig;
  source: ConfigSource;
}

export class ConfigService {
  private appRoot: string;
  private configPath: string;
  private loadedConfig: ServerConfig | null = null;
  private configSource: ConfigSource = 'default';
  private pendingChanges: ServerConfigUpdate | null = null;

  constructor(appRoot: string) {
    this.appRoot = appRoot;
    this.configPath = path.join(appRoot, CONFIG_FILENAME);
  }

  /**
   * Load configuration from environment, file, or defaults
   * Priority: env > file > default
   */
  async load(): Promise<LoadedConfig> {
    // Check environment variables first (highest priority)
    const envDataPath = process.env.DATA_PATH;
    const envPort = process.env.PORT ? parseInt(process.env.PORT) : undefined;

    if (envDataPath) {
      this.loadedConfig = {
        dataPath: envDataPath,
        port: envPort ?? DEFAULT_PORT,
      };
      this.configSource = 'env';
      return { config: this.loadedConfig, source: this.configSource };
    }

    // Try to load from config file
    try {
      const fileContent = await fs.readFile(this.configPath, 'utf-8');
      const fileConfig = JSON.parse(fileContent) as Partial<ServerConfig>;

      this.loadedConfig = {
        dataPath: fileConfig.dataPath ?? path.join(this.appRoot, 'data'),
        port: fileConfig.port ?? envPort ?? DEFAULT_PORT,
      };
      this.configSource = 'file';
      return { config: this.loadedConfig, source: this.configSource };
    } catch {
      // File doesn't exist or is invalid, use defaults
    }

    // Use defaults
    this.loadedConfig = {
      dataPath: path.join(this.appRoot, 'data'),
      port: envPort ?? DEFAULT_PORT,
    };
    this.configSource = 'default';
    return { config: this.loadedConfig, source: this.configSource };
  }

  /**
   * Get the current configuration (must call load() first)
   */
  getConfig(): ServerConfig {
    if (!this.loadedConfig) {
      throw new Error('Configuration not loaded. Call load() first.');
    }
    return this.loadedConfig;
  }

  /**
   * Get the source of the current configuration
   */
  getSource(): ConfigSource {
    return this.configSource;
  }

  /**
   * Check if there are pending changes that require a restart
   */
  hasPendingChanges(): boolean {
    return this.pendingChanges !== null;
  }

  /**
   * Get pending changes
   */
  getPendingChanges(): ServerConfigUpdate | null {
    return this.pendingChanges;
  }

  /**
   * Save configuration updates to the config file
   * Changes won't take effect until server restart
   */
  async save(updates: ServerConfigUpdate): Promise<void> {
    // If source is 'env', we can still save to file but it won't take effect
    // until env vars are removed

    // Read existing file config (if any)
    let existingConfig: Partial<ServerConfig> = {};
    try {
      const fileContent = await fs.readFile(this.configPath, 'utf-8');
      existingConfig = JSON.parse(fileContent);
    } catch {
      // File doesn't exist, start fresh
    }

    // Merge with updates
    const newConfig: ServerConfig = {
      dataPath: updates.dataPath ?? existingConfig.dataPath ?? this.loadedConfig?.dataPath ?? path.join(this.appRoot, 'data'),
      port: updates.port ?? existingConfig.port ?? this.loadedConfig?.port ?? DEFAULT_PORT,
    };

    // Write to file
    await fs.writeFile(this.configPath, JSON.stringify(newConfig, null, 2), 'utf-8');

    // Track pending changes
    this.pendingChanges = updates;
  }

  /**
   * Validate a data path
   */
  async validate(dataPath: string): Promise<ConfigValidationResponse> {
    // Check if path is absolute
    if (!path.isAbsolute(dataPath)) {
      return {
        valid: false,
        exists: false,
        writable: false,
        message: 'Path must be absolute',
      };
    }

    // Check if path exists
    let exists = false;
    try {
      await fs.access(dataPath);
      exists = true;
    } catch {
      // Path doesn't exist, try to create it
      try {
        await fs.mkdir(dataPath, { recursive: true });
        exists = true;
      } catch (err) {
        return {
          valid: false,
          exists: false,
          writable: false,
          message: `Cannot create directory: ${(err as Error).message}`,
        };
      }
    }

    // Check if writable by creating a temp file
    const tempFile = path.join(dataPath, `.bansheeforge-test-${Date.now()}.tmp`);
    try {
      await fs.writeFile(tempFile, 'test');
      await fs.unlink(tempFile);
      return {
        valid: true,
        exists,
        writable: true,
      };
    } catch (err) {
      return {
        valid: false,
        exists,
        writable: false,
        message: `Directory is not writable: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Get the path to the config file
   */
  getConfigPath(): string {
    return this.configPath;
  }
}
