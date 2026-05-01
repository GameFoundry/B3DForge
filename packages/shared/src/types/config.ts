/**
 * Server configuration
 */
export interface ServerConfig {
  dataPath: string;
  port: number;
  /**
   * Network interface the HTTP server binds to. Defaults to `127.0.0.1` so the
   * server is only reachable through a reverse proxy. Set to `0.0.0.0` to expose
   * directly on the local network.
   */
  bindHost: string;
  /**
   * If true, set Secure on the session cookie. Required when serving over HTTPS
   * (i.e. when behind a TLS-terminating reverse proxy).
   */
  cookieSecure: boolean;
}

/**
 * Partial server configuration for updates
 */
export interface ServerConfigUpdate {
  dataPath?: string;
  port?: number;
  bindHost?: string;
  cookieSecure?: boolean;
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
  bindHost: string;
  cookieSecure: boolean;
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
