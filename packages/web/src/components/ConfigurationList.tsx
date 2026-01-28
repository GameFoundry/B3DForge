import { useState } from 'react';
import type { BuildConfiguration, Project, CreateConfigurationInput, ScriptSource, ScriptConfig } from '@banshee-forge/shared';
import {
  useCreateConfiguration,
  useUpdateConfiguration,
  useDeleteConfiguration,
  useConfigurationBuildScript,
  useUpdateConfigurationBuildScript,
  useConfigurationTestScript,
  useUpdateConfigurationTestScript,
  useDeleteConfigurationTestScript,
  useConfigurationFetchScript,
  useUpdateConfigurationFetchScript,
} from '../hooks/useProjects';
import { ScriptEditor } from './ScriptEditor';

interface ConfigurationListProps {
  project: Project;
}

export function ConfigurationList({ project }: ConfigurationListProps) {
  const [expandedConfigId, setExpandedConfigId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);

  const createConfiguration = useCreateConfiguration();
  const updateConfiguration = useUpdateConfiguration();
  const deleteConfiguration = useDeleteConfiguration();

  const configurations = project.configurations ?? [];

  const handleCreate = (input: CreateConfigurationInput) => {
    createConfiguration.mutate(
      { slug: project.slug, input },
      { onSuccess: () => setShowCreateForm(false) }
    );
  };

  const handleUpdate = (configId: string, input: Partial<BuildConfiguration>) => {
    updateConfiguration.mutate(
      { slug: project.slug, configId, input },
      { onSuccess: () => setEditingConfigId(null) }
    );
  };

  const handleDelete = (configId: string) => {
    if (configurations.length <= 1) {
      alert('Cannot delete the only configuration');
      return;
    }
    if (confirm('Are you sure you want to delete this configuration?')) {
      deleteConfiguration.mutate({ slug: project.slug, configId });
    }
  };

  const handleSetDefault = (_configId: string) => {
    // This would require an updateProject call, but for now we'll just show the intent
    // In a real implementation, you'd call projectsApi.update with defaultConfigurationId
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-100">Build Configurations</h2>
        <button
          onClick={() => setShowCreateForm(true)}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Configuration
        </button>
      </div>

      {showCreateForm && (
        <CreateConfigurationForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreateForm(false)}
          isLoading={createConfiguration.isPending}
        />
      )}

      {configurations.length === 0 ? (
        <div className="bg-gray-800 rounded-lg p-8 text-center">
          <p className="text-gray-400 mb-4">No configurations yet</p>
          <button
            onClick={() => setShowCreateForm(true)}
            className="text-blue-400 hover:underline"
          >
            Create your first configuration
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {configurations.map((config) => (
            <ConfigurationItem
              key={config.id}
              configuration={config}
              projectSlug={project.slug}
              isDefault={config.id === project.defaultConfigurationId}
              isExpanded={expandedConfigId === config.id}
              isEditing={editingConfigId === config.id}
              onToggleExpand={() =>
                setExpandedConfigId(expandedConfigId === config.id ? null : config.id)
              }
              onEdit={() => setEditingConfigId(config.id)}
              onCancelEdit={() => setEditingConfigId(null)}
              onSave={(input) => handleUpdate(config.id, input)}
              onDelete={() => handleDelete(config.id)}
              onSetDefault={() => handleSetDefault(config.id)}
              canDelete={configurations.length > 1}
              isSaving={updateConfiguration.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CreateConfigurationFormProps {
  onSubmit: (input: CreateConfigurationInput) => void;
  onCancel: () => void;
  isLoading: boolean;
}

function CreateConfigurationForm({ onSubmit, onCancel, isLoading }: CreateConfigurationFormProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [buildType, setBuildType] = useState('RelWithDebInfo');
  const [autoBuild, setAutoBuild] = useState(true);
  const [forceCleanBuild, setForceCleanBuild] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name,
      description: description || undefined,
      buildScript: { source: 'local' },
      buildType: buildType || undefined,
      autoBuild,
      forceCleanBuild,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="bg-gray-800 rounded-lg p-4 space-y-4">
      <div>
        <label className="block text-sm text-gray-400 mb-1">Configuration Name *</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="e.g., Debug, Release, Tests"
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Brief description of this configuration"
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-1">Build Type</label>
        <input
          type="text"
          value={buildType}
          onChange={(e) => setBuildType(e.target.value)}
          placeholder="e.g., Debug, Release, RelWithDebInfo"
          list="build-types"
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        />
        <datalist id="build-types">
          <option value="Debug" />
          <option value="Release" />
          <option value="RelWithDebInfo" />
          <option value="MinSizeRel" />
        </datalist>
        <p className="text-xs text-gray-500 mt-1">
          Passed to build script as $BUILD_TYPE environment variable
        </p>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={autoBuild}
          onChange={(e) => setAutoBuild(e.target.checked)}
          className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500"
        />
        <span className="text-sm text-gray-300">Include in automatic builds</span>
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={forceCleanBuild}
          onChange={(e) => setForceCleanBuild(e.target.checked)}
          className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500"
        />
        <div>
          <span className="text-sm text-gray-300">Always use clean builds</span>
          <p className="text-xs text-gray-500">Wipe workspace before every build (disables incremental builds)</p>
        </div>
      </label>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-gray-300 hover:text-gray-100"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading || !name}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
        >
          {isLoading ? 'Creating...' : 'Create Configuration'}
        </button>
      </div>
    </form>
  );
}

interface ConfigurationItemProps {
  configuration: BuildConfiguration;
  projectSlug: string;
  isDefault: boolean;
  isExpanded: boolean;
  isEditing: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (input: Partial<BuildConfiguration>) => void;
  onDelete: () => void;
  onSetDefault: () => void;
  canDelete: boolean;
  isSaving: boolean;
}

function ConfigurationItem({
  configuration,
  projectSlug,
  isDefault,
  isExpanded,
  isEditing,
  onToggleExpand,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  canDelete,
  isSaving,
}: ConfigurationItemProps) {
  const [name, setName] = useState(configuration.name);
  const [description, setDescription] = useState(configuration.description ?? '');
  const [buildType, setBuildType] = useState(configuration.buildType ?? '');
  const [autoBuild, setAutoBuild] = useState(configuration.autoBuild);
  const [forceCleanBuild, setForceCleanBuild] = useState(configuration.forceCleanBuild ?? false);

  // Script hooks
  const { data: fetchScriptData } = useConfigurationFetchScript(projectSlug, configuration.id);
  const { data: buildScriptData } = useConfigurationBuildScript(projectSlug, configuration.id);
  const { data: testScriptData } = useConfigurationTestScript(projectSlug, configuration.id);
  const updateFetchScript = useUpdateConfigurationFetchScript();
  const updateBuildScript = useUpdateConfigurationBuildScript();
  const updateTestScript = useUpdateConfigurationTestScript();
  const deleteTestScript = useDeleteConfigurationTestScript();

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      name,
      description: description || undefined,
      buildType: buildType || undefined,
      autoBuild,
      forceCleanBuild,
    });
  };

  const handleSaveFetchScript = (script: string) => {
    updateFetchScript.mutate({ slug: projectSlug, configId: configuration.id, script });
  };

  const handleSaveBuildScript = (script: string) => {
    updateBuildScript.mutate({ slug: projectSlug, configId: configuration.id, script });
  };

  const handleSaveTestScript = (script: string) => {
    updateTestScript.mutate({
      slug: projectSlug,
      configId: configuration.id,
      script,
    });
  };

  const handleDeleteTestScript = () => {
    if (confirm('Are you sure you want to delete the test script?')) {
      deleteTestScript.mutate({ slug: projectSlug, configId: configuration.id });
    }
  };

  const handleBuildScriptSourceChange = (source: ScriptSource, repoPath?: string) => {
    const buildScript: ScriptConfig = { source };
    if (source === 'repo' && repoPath)
      buildScript.repoPath = repoPath;
    onSave({ buildScript });
  };

  const handleTestScriptSourceChange = (source: ScriptSource, repoPath?: string) => {
    const testScript: ScriptConfig = { source };
    if (source === 'repo' && repoPath)
      testScript.repoPath = repoPath;
    onSave({ testScript });
  };

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-700/50"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-3">
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-gray-100">{configuration.name}</span>
              {isDefault && (
                <span className="text-xs px-2 py-0.5 bg-blue-900/50 text-blue-300 rounded">
                  Default
                </span>
              )}
              {configuration.autoBuild && (
                <span className="text-xs px-2 py-0.5 bg-green-900/50 text-green-300 rounded">
                  Auto-build
                </span>
              )}
              {configuration.forceCleanBuild && (
                <span className="text-xs px-2 py-0.5 bg-orange-900/50 text-orange-300 rounded">
                  Clean builds
                </span>
              )}
            </div>
            {configuration.description && (
              <p className="text-sm text-gray-400">{configuration.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onEdit}
            className="p-1.5 text-gray-400 hover:text-gray-200 hover:bg-gray-600 rounded"
            title="Edit"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
              />
            </svg>
          </button>
          {canDelete && (
            <button
              onClick={onDelete}
              className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded"
              title="Delete"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-gray-700 p-4 space-y-6">
          {isEditing ? (
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Build Type</label>
                <input
                  type="text"
                  value={buildType}
                  onChange={(e) => setBuildType(e.target.value)}
                  placeholder="e.g., Debug, Release, RelWithDebInfo"
                  list="build-types-edit"
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100"
                />
                <datalist id="build-types-edit">
                  <option value="Debug" />
                  <option value="Release" />
                  <option value="RelWithDebInfo" />
                  <option value="MinSizeRel" />
                </datalist>
                <p className="text-xs text-gray-500 mt-1">
                  Passed to build script as $BUILD_TYPE environment variable
                </p>
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={autoBuild}
                  onChange={(e) => setAutoBuild(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500"
                />
                <span className="text-sm text-gray-300">Include in automatic builds</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={forceCleanBuild}
                  onChange={(e) => setForceCleanBuild(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500"
                />
                <div>
                  <span className="text-sm text-gray-300">Always use clean builds</span>
                  <p className="text-xs text-gray-500">Wipe workspace before every build (disables incremental builds)</p>
                </div>
              </label>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onCancelEdit}
                  className="px-4 py-2 text-gray-300 hover:text-gray-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
                >
                  {isSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          ) : (
            <>
              {/* Fetch Script - always local bash */}
              <ScriptEditor
                title="Fetch Script"
                description="Clones the repository and checks out the target branch/commit"
                placeholder="Enter your fetch script here..."
                fileName="fetch.sh"
                configId={configuration.id}
                script={fetchScriptData?.script ?? ''}
                onSave={handleSaveFetchScript}
                isSaving={updateFetchScript.isPending}
              />

              {/* Build Script */}
              <ScriptEditor
                title="Build Script"
                description="Compiles the project and produces build artifacts"
                placeholder="Enter your build script here..."
                configId={configuration.id}
                script={buildScriptData?.script ?? ''}
                source={configuration.buildScript?.source ?? 'local'}
                repoPath={configuration.buildScript?.repoPath ?? ''}
                onSave={handleSaveBuildScript}
                onSourceChange={handleBuildScriptSourceChange}
                isSaving={updateBuildScript.isPending}
                isSourceSaving={isSaving}
              />

              {/* Test Script */}
              <ScriptEditor
                title="Test Script"
                description="Runs tests and reports results"
                placeholder="Enter your test script here..."
                configId={configuration.id}
                script={testScriptData?.script ?? ''}
                source={configuration.testScript?.source ?? 'local'}
                repoPath={configuration.testScript?.repoPath ?? ''}
                onSave={handleSaveTestScript}
                onSourceChange={handleTestScriptSourceChange}
                onDelete={handleDeleteTestScript}
                isSaving={updateTestScript.isPending}
                isSourceSaving={isSaving}
                isDeleting={deleteTestScript.isPending}
                isTestScript
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
