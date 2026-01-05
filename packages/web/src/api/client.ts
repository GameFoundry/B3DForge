import type {
  Project, CreateProjectInput, UpdateProjectInput,
  Build, BuildSummary, CreateBuildInput, PaginatedResponse,
  LogLine, QueueStatus, ScriptType, ScriptSource,
  BuildConfiguration, CreateConfigurationInput, UpdateConfigurationInput,
} from '@banshee-forge/shared';

export interface ScriptResponse {
  script: string;
  scriptType: ScriptType;
  source: ScriptSource;
}

const API_BASE = '/api/v1';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.json();
}

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
  updateConfigurationTestScript: (slug: string, configId: string, script: string, scriptType: ScriptType = 'bash') =>
    fetchJson<{ success: boolean }>(`${API_BASE}/projects/${slug}/configurations/${configId}/scripts/test`, {
      method: 'PUT', body: JSON.stringify({ script, scriptType })
    }),
  deleteConfigurationTestScript: (slug: string, configId: string) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/projects/${slug}/configurations/${configId}/scripts/test`, {
      method: 'DELETE'
    }),

  // Fetch script endpoints (always local bash)
  getConfigurationFetchScript: (slug: string, configId: string) =>
    fetchJson<{ script: string; scriptType: 'bash' }>(`${API_BASE}/projects/${slug}/configurations/${configId}/scripts/fetch`),
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
