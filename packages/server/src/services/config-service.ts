import fs from 'fs/promises';
import path from 'path';
import type { ServerConfig, ServerConfigUpdate, ConfigSource, ConfigValidationResponse } from '@banshee-forge/shared';

const CONFIG_FILENAME = 'config.json';
const DEFAULT_PORT = 3003;
const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_COOKIE_SECURE = false;

interface LoadedConfig {
  config: ServerConfig;
  source: ConfigSource;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return undefined;
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
    const envDataPath = process.env.DATA_PATH;
    const envPort = process.env.PORT ? parseInt(process.env.PORT) : undefined;
    const envBindHost = process.env.BIND_HOST;
    const envCookieSecure = parseBool(process.env.COOKIE_SECURE);

    // Try to load from config file first so we can layer env on top
    let fileConfig: Partial<ServerConfig> = {};
    let fileExists = false;
    try {
      const fileContent = await fs.readFile(this.configPath, 'utf-8');
      fileConfig = JSON.parse(fileContent) as Partial<ServerConfig>;
      fileExists = true;
    } catch {
      // File doesn't exist or is invalid
    }

    // If any env variable is set, mark source as env (highest priority)
    const anyEnvSet = envDataPath !== undefined
      || envPort !== undefined
      || envBindHost !== undefined
      || envCookieSecure !== undefined;

    if (anyEnvSet) {
      this.loadedConfig = {
        dataPath: envDataPath ?? fileConfig.dataPath ?? path.join(this.appRoot, 'data'),
        port: envPort ?? fileConfig.port ?? DEFAULT_PORT,
        bindHost: envBindHost ?? fileConfig.bindHost ?? DEFAULT_BIND_HOST,
        cookieSecure: envCookieSecure ?? fileConfig.cookieSecure ?? DEFAULT_COOKIE_SECURE,
      };
      this.configSource = 'env';
      return { config: this.loadedConfig, source: this.configSource };
    }

    if (fileExists) {
      this.loadedConfig = {
        dataPath: fileConfig.dataPath ?? path.join(this.appRoot, 'data'),
        port: fileConfig.port ?? DEFAULT_PORT,
        bindHost: fileConfig.bindHost ?? DEFAULT_BIND_HOST,
        cookieSecure: fileConfig.cookieSecure ?? DEFAULT_COOKIE_SECURE,
      };
      this.configSource = 'file';
      return { config: this.loadedConfig, source: this.configSource };
    }

    this.loadedConfig = {
      dataPath: path.join(this.appRoot, 'data'),
      port: DEFAULT_PORT,
      bindHost: DEFAULT_BIND_HOST,
      cookieSecure: DEFAULT_COOKIE_SECURE,
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
    let existingConfig: Partial<ServerConfig> = {};
    try {
      const fileContent = await fs.readFile(this.configPath, 'utf-8');
      existingConfig = JSON.parse(fileContent);
    } catch {
      // File doesn't exist, start fresh
    }

    const newConfig: ServerConfig = {
      dataPath: updates.dataPath ?? existingConfig.dataPath ?? this.loadedConfig?.dataPath ?? path.join(this.appRoot, 'data'),
      port: updates.port ?? existingConfig.port ?? this.loadedConfig?.port ?? DEFAULT_PORT,
      bindHost: updates.bindHost ?? existingConfig.bindHost ?? this.loadedConfig?.bindHost ?? DEFAULT_BIND_HOST,
      cookieSecure: updates.cookieSecure ?? existingConfig.cookieSecure ?? this.loadedConfig?.cookieSecure ?? DEFAULT_COOKIE_SECURE,
    };

    await fs.writeFile(this.configPath, JSON.stringify(newConfig, null, 2), 'utf-8');
    this.pendingChanges = updates;
  }

  /**
   * Validate a data path
   */
  async validate(dataPath: string): Promise<ConfigValidationResponse> {
    if (!path.isAbsolute(dataPath)) {
      return {
        valid: false,
        exists: false,
        writable: false,
        message: 'Path must be absolute',
      };
    }

    let exists = false;
    try {
      await fs.access(dataPath);
      exists = true;
    } catch {
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
