/**
 * Deployment settings. The credentials file never leaves the orchestrator: agents only send
 * files, the orchestrator runs `deploy.sh` and pushes promoted branches.
 */
export interface DeploySettings {
	/**
	 * Absolute path, on the orchestrator's disk, of a key=value credentials file. The
	 * orchestrator reads only `GIT_TOKEN` (and optionally `GIT_USER`) from it, for pushing
	 * promoted branches over HTTPS; every other key is opaque to it and left for `deploy.sh`,
	 * which receives the path as `DEPLOY_CREDENTIALS_FILE`.
	 */
	credentialsFile?: string;
}

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
  /** Applied immediately when saved; no restart needed. */
  deploy: DeploySettings;
}

/**
 * Partial server configuration for updates
 */
export interface ServerConfigUpdate {
  dataPath?: string;
  port?: number;
  bindHost?: string;
  cookieSecure?: boolean;
  deploy?: Partial<DeploySettings>;
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
  deploy: DeploySettings;
  /** Whether the credentials file currently exists on the orchestrator's disk. */
  credentialsFileExists: boolean;
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
