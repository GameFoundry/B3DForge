import type {
  Project, CreateProjectInput, UpdateProjectInput,
  Build, BuildSummary, CreateBuildInput, PaginatedResponse,
  LogLine, QueueStatus, ScriptSource, PollingStatus,
  BuildConfiguration, CreateConfigurationInput, UpdateConfigurationInput,
  ConfigResponse, ConfigUpdateResponse, ConfigValidationResponse, ServerConfigUpdate,
  BuildTestResults, UnitTestOutput, TestSuite, AggregatedSnapshotResult,
  ComparisonResult, ReferenceInfo, ReferenceManifest,
  AuthMeResponse, LoginRequest,
  AgentInfo, AgentTokenPublic,
} from '@banshee-forge/shared';

export interface ScriptResponse {
  script: string;
  source: ScriptSource;
}

const API_BASE = '/api/v1';

/** Fired when any API call returns 401. AuthContext listens for this and resets. */
export const AUTH_REQUIRED_EVENT = 'bsf:auth-required';

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
    throw new UnauthorizedError();
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.json();
}

// Auth API
export const authApi = {
  me: () => fetchJson<AuthMeResponse>(`${API_BASE}/auth/me`),
  login: (input: LoginRequest) =>
    fetchJson<AuthMeResponse>(`${API_BASE}/auth/login`, {
      method: 'POST', body: JSON.stringify(input),
    }),
  logout: () =>
    fetchJson<{ success: boolean }>(`${API_BASE}/auth/logout`, { method: 'POST' }),
};

// Projects API
export const projectsApi = {
  list: () => fetchJson<{ projects: Project[] }>(`${API_BASE}/projects`),
  get: (slug: string) => fetchJson<Project>(`${API_BASE}/projects/${slug}`),
  create: (input: CreateProjectInput) =>
    fetchJson<Project>(`${API_BASE}/projects`, { method: 'POST', body: JSON.stringify(input) }),
  update: (slug: string, input: UpdateProjectInput) =>
    fetchJson<Project>(`${API_BASE}/projects/${slug}`, { method: 'PUT', body: JSON.stringify(input) }),
  delete: (slug: string) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/projects/${slug}`, { method: 'DELETE' }),

  // Configuration endpoints
  listConfigurations: (slug: string) =>
    fetchJson<{ configurations: BuildConfiguration[] }>(`${API_BASE}/projects/${slug}/configurations`),
  getConfiguration: (slug: string, configId: string) =>
    fetchJson<BuildConfiguration>(`${API_BASE}/projects/${slug}/configurations/${configId}`),
  createConfiguration: (slug: string, input: CreateConfigurationInput) =>
    fetchJson<BuildConfiguration>(`${API_BASE}/projects/${slug}/configurations`, {
      method: 'POST', body: JSON.stringify(input)
    }),
  updateConfiguration: (slug: string, configId: string, input: UpdateConfigurationInput) =>
    fetchJson<BuildConfiguration>(`${API_BASE}/projects/${slug}/configurations/${configId}`, {
      method: 'PUT', body: JSON.stringify(input)
    }),
  deleteConfiguration: (slug: string, configId: string) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/projects/${slug}/configurations/${configId}`, {
      method: 'DELETE'
    }),

  // Configuration script endpoints
  getConfigurationBuildScript: (slug: string, configId: string) =>
    fetchJson<ScriptResponse>(`${API_BASE}/projects/${slug}/configurations/${configId}/scripts/build`),
  updateConfigurationBuildScript: (slug: string, configId: string, script: string) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/projects/${slug}/configurations/${configId}/scripts/build`, {
      method: 'PUT', body: JSON.stringify({ script })
    }),
  getConfigurationTestScript: (slug: string, configId: string) =>
    fetchJson<ScriptResponse>(`${API_BASE}/projects/${slug}/configurations/${configId}/scripts/test`),
  updateConfigurationTestScript: (slug: string, configId: string, script: string) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/projects/${slug}/configurations/${configId}/scripts/test`, {
      method: 'PUT', body: JSON.stringify({ script })
    }),
  deleteConfigurationTestScript: (slug: string, configId: string) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/projects/${slug}/configurations/${configId}/scripts/test`, {
      method: 'DELETE'
    }),

  // Polling endpoints
  getPollingStatus: (slug: string) =>
    fetchJson<PollingStatus>(`${API_BASE}/projects/${slug}/polling-status`),
  pollNow: (slug: string) =>
    fetchJson<PollingStatus>(`${API_BASE}/projects/${slug}/poll-now`, { method: 'POST' }),

  // Fetch script endpoints (always local bash)
  getProjectFetchScript: (slug: string) =>
    fetchJson<{ script: string }>(`${API_BASE}/projects/${slug}/scripts/fetch`),
  updateProjectFetchScript: (slug: string, script: string) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/projects/${slug}/scripts/fetch`, {
      method: 'PUT', body: JSON.stringify({ script })
    }),
  getConfigurationFetchScript: (slug: string, configId: string) =>
    fetchJson<{ script: string }>(`${API_BASE}/projects/${slug}/configurations/${configId}/scripts/fetch`),
  updateConfigurationFetchScript: (slug: string, configId: string, script: string) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/projects/${slug}/configurations/${configId}/scripts/fetch`, {
      method: 'PUT', body: JSON.stringify({ script })
    }),
};

// Builds API
export const buildsApi = {
  list: (projectSlug: string, page = 1, pageSize = 20) =>
    fetchJson<PaginatedResponse<BuildSummary>>(`${API_BASE}/projects/${projectSlug}/builds?page=${page}&pageSize=${pageSize}`),
  get: (id: string) => fetchJson<Build>(`${API_BASE}/builds/${id}`),
  trigger: (projectSlug: string, input?: CreateBuildInput) =>
    fetchJson<Build>(`${API_BASE}/projects/${projectSlug}/builds`, {
      method: 'POST', body: JSON.stringify(input ?? {})
    }),
  cancel: (id: string) => fetchJson<Build>(`${API_BASE}/builds/${id}`, { method: 'DELETE' }),
  getLog: (id: string) => fetchJson<{ log: string }>(`${API_BASE}/builds/${id}/log`),
  getParsedLog: (id: string, fromLine = 0) =>
    fetchJson<{ lines: LogLine[]; phases: string[]; totalLines: number }>(
      `${API_BASE}/builds/${id}/log/parsed?fromLine=${fromLine}`
    ),
};

// Queue API
export const queueApi = {
  getStatus: () => fetchJson<QueueStatus>(`${API_BASE}/queue`),
};

// Config API
export const configApi = {
  get: () => fetchJson<ConfigResponse>(`${API_BASE}/config`),
  update: (updates: ServerConfigUpdate) =>
    fetchJson<ConfigUpdateResponse>(`${API_BASE}/config`, {
      method: 'PUT', body: JSON.stringify(updates)
    }),
  validate: (dataPath: string) =>
    fetchJson<ConfigValidationResponse>(`${API_BASE}/config/validate`, {
      method: 'POST', body: JSON.stringify({ dataPath })
    }),
};

// Comparison result with hasReference flag
export interface ComparisonResultWithRef extends ComparisonResult {
  hasReference: boolean;
  message?: string;
}

// Tests API
export const testsApi = {
  getResults: (buildId: string) =>
    fetchJson<BuildTestResults>(`${API_BASE}/builds/${buildId}/tests`),
  getUnitTests: (buildId: string) =>
    fetchJson<UnitTestOutput>(`${API_BASE}/builds/${buildId}/tests/unit`),
  getUnitTestLog: (buildId: string) =>
    fetchJson<{ log: string }>(`${API_BASE}/builds/${buildId}/tests/unit/log`),
  getTestSuite: (buildId: string, suiteId: string) =>
    fetchJson<TestSuite>(`${API_BASE}/builds/${buildId}/tests/unit/${suiteId}`),
  getSnapshots: (buildId: string) =>
    fetchJson<{ snapshots: AggregatedSnapshotResult[] }>(`${API_BASE}/builds/${buildId}/tests/snapshots`),
  getSnapshotDetails: (buildId: string, testName: string) =>
    fetchJson<AggregatedSnapshotResult>(`${API_BASE}/builds/${buildId}/tests/snapshots/${testName}`),
  getSnapshotLog: (buildId: string, testName: string) =>
    fetchJson<{ log: string }>(`${API_BASE}/builds/${buildId}/tests/snapshots/${testName}/log`),
  compareSnapshot: (buildId: string, testName: string) =>
    fetchJson<ComparisonResultWithRef>(`${API_BASE}/builds/${buildId}/tests/snapshots/${testName}/compare`),
  // URL getters for images (not fetched as JSON)
  getScreenshotUrl: (buildId: string, testName: string) =>
    `${API_BASE}/builds/${buildId}/tests/snapshots/${testName}/screenshot`,
  getDiffUrl: (buildId: string, testName: string) =>
    `${API_BASE}/builds/${buildId}/tests/snapshots/${testName}/diff`,
};

// Agents API
export const agentsApi = {
  list: () => fetchJson<{ agents: AgentInfo[] }>(`${API_BASE}/agents`),
  get: (id: string) => fetchJson<AgentInfo>(`${API_BASE}/agents/${id}`),
};

// Agent token API
export interface CreatedAgentTokenResponse extends AgentTokenPublic {
  plaintext: string;
}

export const agentTokensApi = {
  list: () => fetchJson<{ tokens: AgentTokenPublic[] }>(`${API_BASE}/agent-tokens`),
  create: (name: string) =>
    fetchJson<CreatedAgentTokenResponse>(`${API_BASE}/agent-tokens`, {
      method: 'POST', body: JSON.stringify({ name }),
    }),
  revoke: (id: string) =>
    fetch(`${API_BASE}/agent-tokens/${id}`, { method: 'DELETE', credentials: 'include' })
      .then(res => { if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`); }),
};

// References API
export const referencesApi = {
  listAll: (projectSlug: string) =>
    fetchJson<{ references: Record<string, ReferenceManifest> }>(`${API_BASE}/projects/${projectSlug}/references`),
  list: (projectSlug: string, configId: string) =>
    fetchJson<{ references: ReferenceInfo[] }>(`${API_BASE}/projects/${projectSlug}/references/${configId}`),
  getInfo: (projectSlug: string, configId: string, testName: string) =>
    fetchJson<ReferenceInfo>(`${API_BASE}/projects/${projectSlug}/references/${configId}/${testName}/info`),
  setReference: (projectSlug: string, configId: string, testName: string, buildId: string) =>
    fetchJson<ReferenceInfo>(`${API_BASE}/projects/${projectSlug}/references/${configId}/${testName}`, {
      method: 'PUT', body: JSON.stringify({ buildId })
    }),
  deleteReference: (projectSlug: string, configId: string, testName: string) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/projects/${projectSlug}/references/${configId}/${testName}`, {
      method: 'DELETE'
    }),
  copyReferences: (projectSlug: string, destConfigId: string, sourceConfigId: string) =>
    fetchJson<{ success: boolean; copiedCount: number }>(`${API_BASE}/projects/${projectSlug}/references/${destConfigId}/copy`, {
      method: 'POST', body: JSON.stringify({ sourceConfigId })
    }),
  // URL getter for reference image
  getReferenceUrl: (projectSlug: string, configId: string, testName: string) =>
    `${API_BASE}/projects/${projectSlug}/references/${configId}/${testName}`,
};
