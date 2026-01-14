/**
 * Server configuration
 */
export interface ServerConfig {
  dataPath: string;
  port: number;
}

/**
 * Partial server configuration for updates
 */
export interface ServerConfigUpdate {
  dataPath?: string;
  port?: number;
}

/**
 * Source of the current configuration
 */
export type ConfigSource = 'env' | 'file' | 'default';

/**
 * Response from GET /api/v1/config
 */
export interface ConfigResponse {
  dataPath: string;
  port: number;
  configSource: ConfigSource;
  pendingRestart: boolean;
}

/**
 * Response from PUT /api/v1/config
 */
export interface ConfigUpdateResponse {
  success: boolean;
  requiresRestart: boolean;
  message: string;
}

/**
 * Response from POST /api/v1/config/validate
 */
export interface ConfigValidationResponse {
  valid: boolean;
  exists: boolean;
  writable: boolean;
  message?: string;
}
