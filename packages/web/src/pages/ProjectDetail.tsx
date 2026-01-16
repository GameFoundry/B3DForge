import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { CreateBuildInput } from '@banshee-forge/shared';
import { useProject } from '../hooks/useProjects';
import { useBuilds, useTriggerBuild } from '../hooks/useBuilds';
import { useBuildsUpdates } from '../hooks/useBuildsUpdates';
import { BuildStatusBadge } from '../components/BuildStatusBadge';
import { TriggerBuildModal } from '../components/TriggerBuildModal';
import { ConfigurationList } from '../components/ConfigurationList';

export function ProjectDetail() {
  const { slug } = useParams<{ slug: string }>();
  const { data: project, isLoading: projectLoading } = useProject(slug!);
  const { data: buildsData, isLoading: buildsLoading } = useBuilds(slug!);
  const triggerBuild = useTriggerBuild();
  const [showTriggerModal, setShowTriggerModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'builds' | 'configurations'>('builds');

  // Listen for build status updates to refresh the list
  useBuildsUpdates(slug);

  if (projectLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold text-gray-300 mb-2">Project not found</h2>
        <Link to="/" className="text-blue-400 hover:underline">
          Return to dashboard
        </Link>
      </div>
    );
  }

  const handleTriggerBuild = (input: CreateBuildInput) => {
    triggerBuild.mutate(
      { projectSlug: slug!, input },
      {
        onSuccess: () => setShowTriggerModal(false),
      }
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <Link to="/" className="text-blue-400 hover:underline text-sm mb-2 inline-block">
            &larr; Back to projects
          </Link>
          <h1 className="text-2xl font-bold text-gray-100">{project.name}</h1>
          <p className="text-gray-400">{project.description}</p>
        </div>
        <button
          onClick={() => setShowTriggerModal(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Trigger Build
        </button>
      </div>

      {/* Project Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-gray-800 rounded-lg p-4">
          <h2 className="text-sm font-medium text-gray-400 mb-3">Repository</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">URL</dt>
              <dd className="text-gray-300 font-mono text-xs truncate max-w-[250px]" title={project.gitUrl}>
                {project.gitUrl}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Branch</dt>
              <dd className="text-gray-300">{project.gitBranch}</dd>
            </div>
            {project.lastCommit && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Last Commit</dt>
                <dd className="text-gray-300 font-mono">{project.lastCommit.slice(0, 7)}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="bg-gray-800 rounded-lg p-4">
          <h2 className="text-sm font-medium text-gray-400 mb-3">Settings</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Auto Build</dt>
              <dd>
                {project.autoBuild ? (
                  <span className="text-green-400">Enabled</span>
                ) : (
                  <span className="text-gray-500">Disabled</span>
                )}
              </dd>
            </div>
            {project.autoBuild && project.pollInterval && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Poll Interval</dt>
                <dd className="text-gray-300">{project.pollInterval}s</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-gray-500">Configurations</dt>
              <dd className="text-gray-300">{project.configurations?.length ?? 0}</dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-700">
        <nav className="flex gap-4">
          <button
            onClick={() => setActiveTab('builds')}
            className={`py-2 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'builds'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-300'
            }`}
          >
            Build History
          </button>
          <button
            onClick={() => setActiveTab('configurations')}
            className={`py-2 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'configurations'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-300'
            }`}
          >
            Configurations
          </button>
        </nav>
      </div>

      {/* Build History Tab */}
      {activeTab === 'builds' && (
        <div>
          <h2 className="text-lg font-semibold text-gray-100 mb-4">Build History</h2>
        {buildsLoading ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
          </div>
        ) : !buildsData?.items.length ? (
          <div className="text-center py-12 bg-gray-800 rounded-lg">
            <svg className="w-12 h-12 mx-auto text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <p className="text-gray-400">No builds yet</p>
            <button
              onClick={() => setShowTriggerModal(true)}
              className="mt-4 text-blue-400 hover:underline"
            >
              Trigger your first build
            </button>
          </div>
        ) : (
          <div className="bg-gray-800 rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-700">
              <thead className="bg-gray-900/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">#</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Config</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Commit</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Trigger</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Duration</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Warnings</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Errors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {buildsData.items.map((build) => (
                  <tr key={build.id} className="hover:bg-gray-700/50 transition-colors">
                    <td className="px-4 py-3">
                      <Link to={`/builds/${build.id}`} className="text-blue-400 hover:underline font-medium">
                        #{build.buildNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <BuildStatusBadge status={build.status} />
                        {build.cleanBuild && (
                          <span className="text-xs px-1.5 py-0.5 bg-orange-900/30 text-orange-400 rounded" title="Clean build">
                            C
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-300">
                      {build.configurationName || '-'}
                    </td>
                    <td className="px-4 py-3 font-mono text-sm text-gray-300">
                      {build.gitCommit?.slice(0, 7) || '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-400 capitalize">
                      {build.triggerType}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-300">
                      {build.durationMs ? `${(build.durationMs / 1000).toFixed(1)}s` : '-'}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {build.warningCount ? (
                        <span className="text-yellow-400">{build.warningCount}</span>
                      ) : (
                        <span className="text-gray-500">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {build.errorCount ? (
                        <span className="text-red-400">{build.errorCount}</span>
                      ) : (
                        <span className="text-gray-500">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {buildsData.totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-700">
                <div className="text-sm text-gray-400">
                  Page {buildsData.page} of {buildsData.totalPages} ({buildsData.total} builds)
                </div>
                <div className="flex gap-2">
                  <button
                    disabled={buildsData.page <= 1}
                    className="px-3 py-1 bg-gray-700 rounded text-sm disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <button
                    disabled={buildsData.page >= buildsData.totalPages}
                    className="px-3 py-1 bg-gray-700 rounded text-sm disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        </div>
      )}

      {/* Configurations Tab */}
      {activeTab === 'configurations' && (
        <ConfigurationList project={project} />
      )}

      {/* Trigger Build Modal */}
      {showTriggerModal && (
        <TriggerBuildModal
          project={project}
          onTrigger={handleTriggerBuild}
          onClose={() => setShowTriggerModal(false)}
          isLoading={triggerBuild.isPending}
        />
      )}
    </div>
  );
}
