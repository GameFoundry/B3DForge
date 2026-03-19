import { useState } from 'react';
import type { Project, WatchedRepository } from '@banshee-forge/shared';
import { useUpdateProject, usePollingStatus, usePollNow } from '../hooks/useProjects';

interface AutoBuildSettingsProps {
  project: Project;
}

const POLL_INTERVAL_PRESETS = [
  { label: '1 minute', value: 60 },
  { label: '5 minutes', value: 300 },
  { label: '15 minutes', value: 900 },
  { label: '30 minutes', value: 1800 },
  { label: '1 hour', value: 3600 },
  { label: 'Custom', value: -1 },
];

export function AutoBuildSettings({ project }: AutoBuildSettingsProps) {
  const updateProject = useUpdateProject();
  const { data: pollingStatus } = usePollingStatus(project.slug);
  const pollNow = usePollNow();

  const [showAddRepo, setShowAddRepo] = useState(false);
  const [editingRepoId, setEditingRepoId] = useState<string | null>(null);
  const [customInterval, setCustomInterval] = useState<string>(String(project.pollInterval));

  const watchedRepos = project.watchedRepositories ?? [];
  const isPresetInterval = POLL_INTERVAL_PRESETS.some(
    p => p.value === project.pollInterval && p.value !== -1
  );

  const handleToggleAutoBuild = () => {
    updateProject.mutate({
      slug: project.slug,
      input: { autoBuild: !project.autoBuild },
    });
  };

  const handlePollIntervalChange = (value: number) => {
    if (value === -1) return; // Custom selected, wait for input
    updateProject.mutate({
      slug: project.slug,
      input: { pollInterval: value },
    });
  };

  const handleCustomIntervalSave = () => {
    const seconds = parseInt(customInterval);
    if (isNaN(seconds) || seconds < 10) return;
    updateProject.mutate({
      slug: project.slug,
      input: { pollInterval: seconds },
    });
  };

  const handleAddRepo = (repo: Omit<WatchedRepository, 'id'>) => {
    const id = `repo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newRepo: WatchedRepository = { ...repo, id };
    updateProject.mutate({
      slug: project.slug,
      input: { watchedRepositories: [...watchedRepos, newRepo] },
    });
    setShowAddRepo(false);
  };

  const handleUpdateRepo = (repoId: string, updates: Partial<WatchedRepository>) => {
    const updated = watchedRepos.map(r =>
      r.id === repoId ? { ...r, ...updates } : r
    );
    updateProject.mutate({
      slug: project.slug,
      input: { watchedRepositories: updated },
    });
    setEditingRepoId(null);
  };

  const handleDeleteRepo = (repoId: string) => {
    if (!confirm('Remove this watched repository?')) return;
    const filtered = watchedRepos.filter(r => r.id !== repoId);
    updateProject.mutate({
      slug: project.slug,
      input: { watchedRepositories: filtered },
    });
  };

  const handlePollNow = () => {
    pollNow.mutate(project.slug);
  };

  return (
    <div className="space-y-6">
      {/* Auto-Build Toggle */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-200">Auto-Build</h3>
            <p className="text-xs text-gray-400 mt-1">
              Automatically trigger builds when new commits are detected
            </p>
          </div>
          <button
            onClick={handleToggleAutoBuild}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              project.autoBuild ? 'bg-blue-600' : 'bg-gray-600'
            }`}
            disabled={updateProject.isPending}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                project.autoBuild ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Poll Interval */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-200 mb-3">Poll Interval</h3>
        <div className="flex flex-wrap gap-2">
          {POLL_INTERVAL_PRESETS.map(preset => (
            <button
              key={preset.value}
              onClick={() => {
                if (preset.value === -1) {
                  setCustomInterval(String(project.pollInterval));
                } else {
                  handlePollIntervalChange(preset.value);
                }
              }}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${
                preset.value === project.pollInterval || (preset.value === -1 && !isPresetInterval)
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {!isPresetInterval && (
          <div className="mt-3 flex items-center gap-2">
            <input
              type="number"
              min="10"
              value={customInterval}
              onChange={e => setCustomInterval(e.target.value)}
              className="w-24 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200"
              placeholder="Seconds"
            />
            <span className="text-xs text-gray-400">seconds</span>
            <button
              onClick={handleCustomIntervalSave}
              className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded"
            >
              Save
            </button>
          </div>
        )}
      </div>

      {/* Watched Repositories */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-200">Watched Repositories</h3>
          <button
            onClick={() => setShowAddRepo(true)}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Repository
          </button>
        </div>

        {showAddRepo && (
          <RepoForm
            onSubmit={handleAddRepo}
            onCancel={() => setShowAddRepo(false)}
          />
        )}

        {watchedRepos.length === 0 ? (
          <p className="text-sm text-gray-500 py-4 text-center">
            No watched repositories. Add repositories to enable auto-build polling.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-700">
            <table className="min-w-full divide-y divide-gray-700">
              <thead className="bg-gray-900/50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-400 uppercase">Name</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-400 uppercase">URL</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-400 uppercase">Branch</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-400 uppercase">Last Commit</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-400 uppercase">Status</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-400 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {watchedRepos.map(repo => {
                  const repoStatus = pollingStatus?.repositories.find(r => r.id === repo.id);

                  if (editingRepoId === repo.id) {
                    return (
                      <tr key={repo.id}>
                        <td colSpan={6} className="px-3 py-2">
                          <RepoForm
                            initialValues={repo}
                            onSubmit={(values) => handleUpdateRepo(repo.id, values)}
                            onCancel={() => setEditingRepoId(null)}
                          />
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <tr key={repo.id} className="hover:bg-gray-700/50">
                      <td className="px-3 py-2 text-sm text-gray-200">{repo.name}</td>
                      <td className="px-3 py-2 text-sm text-gray-300 font-mono text-xs truncate max-w-[200px]" title={repo.gitUrl}>
                        {repo.gitUrl}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-300">{repo.gitBranch}</td>
                      <td className="px-3 py-2 text-sm text-gray-300 font-mono">
                        {repo.lastCommit?.slice(0, 7) ?? '-'}
                      </td>
                      <td className="px-3 py-2 text-sm">
                        {repoStatus?.error ? (
                          <span className="text-red-400" title={repoStatus.error}>Error</span>
                        ) : repoStatus?.lastCheckedAt ? (
                          <span className="text-green-400">OK</span>
                        ) : (
                          <span className="text-gray-500">Pending</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => setEditingRepoId(repo.id)}
                          className="text-blue-400 hover:text-blue-300 text-sm mr-2"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteRepo(repo.id)}
                          className="text-red-400 hover:text-red-300 text-sm"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Polling Status */}
      {project.autoBuild && pollingStatus && (
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-200">Polling Status</h3>
            <button
              onClick={handlePollNow}
              disabled={pollNow.isPending}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded disabled:opacity-50"
            >
              {pollNow.isPending ? 'Polling...' : 'Poll Now'}
            </button>
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Status</dt>
              <dd>
                {pollingStatus.enabled ? (
                  <span className="text-green-400">Active</span>
                ) : (
                  <span className="text-gray-500">Inactive</span>
                )}
              </dd>
            </div>
            {pollingStatus.lastPollAt && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Last Polled</dt>
                <dd className="text-gray-300">{formatRelativeTime(pollingStatus.lastPollAt)}</dd>
              </div>
            )}
            {pollingStatus.nextPollAt && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Next Poll</dt>
                <dd className="text-gray-300">{formatRelativeTime(pollingStatus.nextPollAt)}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

// ============================================
// Sub-components
// ============================================

interface RepoFormProps {
  initialValues?: Partial<WatchedRepository>;
  onSubmit: (values: Omit<WatchedRepository, 'id'>) => void;
  onCancel: () => void;
}

function RepoForm({ initialValues, onSubmit, onCancel }: RepoFormProps) {
  const [name, setName] = useState(initialValues?.name ?? '');
  const [gitUrl, setGitUrl] = useState(initialValues?.gitUrl ?? '');
  const [gitBranch, setGitBranch] = useState(initialValues?.gitBranch ?? 'master');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !gitUrl.trim() || !gitBranch.trim()) return;
    onSubmit({ name: name.trim(), gitUrl: gitUrl.trim(), gitBranch: gitBranch.trim() });
  };

  return (
    <form onSubmit={handleSubmit} className="bg-gray-900/50 rounded-lg p-3 mb-3 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g., Framework"
            className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200"
            required
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Git URL</label>
          <input
            type="text"
            value={gitUrl}
            onChange={e => setGitUrl(e.target.value)}
            placeholder="https://github.com/user/repo.git"
            className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200"
            required
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Branch</label>
          <input
            type="text"
            value={gitBranch}
            onChange={e => setGitBranch(e.target.value)}
            placeholder="master"
            className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200"
            required
          />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded"
        >
          {initialValues ? 'Update' : 'Add'}
        </button>
      </div>
    </form>
  );
}

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 0) {
    // Future time
    const absDiff = Math.abs(diffMs);
    if (absDiff < 60000) return `in ${Math.round(absDiff / 1000)}s`;
    if (absDiff < 3600000) return `in ${Math.round(absDiff / 60000)}m`;
    return `in ${Math.round(absDiff / 3600000)}h`;
  }

  if (diffMs < 60000) return `${Math.round(diffMs / 1000)}s ago`;
  if (diffMs < 3600000) return `${Math.round(diffMs / 60000)}m ago`;
  return `${Math.round(diffMs / 3600000)}h ago`;
}
