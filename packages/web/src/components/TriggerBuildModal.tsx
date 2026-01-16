import { useState, useMemo, useEffect } from 'react';
import type { Project, CreateBuildInput, ConfigSchema, ProjectConfig, BuildConfiguration } from '@banshee-forge/shared';

interface TriggerBuildModalProps {
  project: Project;
  onTrigger: (input: CreateBuildInput) => void;
  onClose: () => void;
  isLoading?: boolean;
}

export function TriggerBuildModal({ project, onTrigger, onClose, isLoading = false }: TriggerBuildModalProps) {
  const configurations = project.configurations ?? [];
  const hasConfigurations = configurations.length > 0;

  // Default to project's default configuration or first available
  const defaultConfigId = project.defaultConfigurationId ?? configurations[0]?.id ?? '';
  const [selectedConfigId, setSelectedConfigId] = useState(defaultConfigId);
  const [gitCommit, setGitCommit] = useState('');
  const [gitBranch, setGitBranch] = useState(project.gitBranch);
  const [cleanBuild, setCleanBuild] = useState(false);

  // Get selected configuration
  const selectedConfig: BuildConfiguration | undefined = useMemo(() => {
    return configurations.find(c => c.id === selectedConfigId);
  }, [configurations, selectedConfigId]);

  // Use configuration's config schema and defaults
  const configSchema = useMemo((): ConfigSchema => {
    return selectedConfig?.configSchema ?? {};
  }, [selectedConfig]);

  const defaultConfig = useMemo((): ProjectConfig => {
    return selectedConfig?.defaultConfig ?? {};
  }, [selectedConfig]);

  const [config, setConfig] = useState<ProjectConfig>(() => ({ ...defaultConfig }));

  // Reset config when configuration changes
  useEffect(() => {
    setConfig({ ...defaultConfig });
  }, [defaultConfig]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const input: CreateBuildInput = {
      configurationId: selectedConfigId || undefined,
      gitBranch,
      config,
      cleanBuild,
    };

    if (gitCommit.trim())
      input.gitCommit = gitCommit.trim();

    onTrigger(input);
  };

  const updateConfig = (key: string, value: string | number | boolean) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const renderConfigField = (key: string, schema: ConfigSchema[string]) => {
    const value = config[key] ?? schema.default;

    switch (schema.type) {
      case 'boolean':
        return (
          <label key={key} className="flex items-center gap-3 py-2">
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => updateConfig(key, e.target.checked)}
              className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
            />
            <span className="text-gray-200">{schema.label ?? key}</span>
          </label>
        );

      case 'select':
        return (
          <div key={key} className="py-2">
            <label className="block text-sm text-gray-400 mb-1">{schema.label ?? key}</label>
            <select
              value={String(value)}
              onChange={(e) => updateConfig(key, e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            >
              {schema.options?.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
        );

      case 'string':
        return (
          <div key={key} className="py-2">
            <label className="block text-sm text-gray-400 mb-1">{schema.label ?? key}</label>
            <input
              type="text"
              value={String(value ?? '')}
              onChange={(e) => updateConfig(key, e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
        );

      case 'number':
        return (
          <div key={key} className="py-2">
            <label className="block text-sm text-gray-400 mb-1">{schema.label ?? key}</label>
            <input
              type="number"
              value={Number(value ?? 0)}
              onChange={(e) => updateConfig(key, parseFloat(e.target.value))}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-gray-700 sticky top-0 bg-gray-800">
          <h2 className="text-lg font-semibold text-gray-100">Trigger Build</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200"
            disabled={isLoading}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4">
          <div className="space-y-4">
            {/* Configuration Selector */}
            {hasConfigurations && (
              <div>
                <label className="block text-sm text-gray-400 mb-1">Configuration</label>
                <select
                  value={selectedConfigId}
                  onChange={(e) => setSelectedConfigId(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  {configurations.map((cfg) => (
                    <option key={cfg.id} value={cfg.id}>
                      {cfg.name}
                      {cfg.id === project.defaultConfigurationId ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
                {selectedConfig?.description && (
                  <p className="text-xs text-gray-500 mt-1">{selectedConfig.description}</p>
                )}
              </div>
            )}

            {/* Git Branch */}
            <div>
              <label className="block text-sm text-gray-400 mb-1">Branch</label>
              <input
                type="text"
                value={gitBranch}
                onChange={(e) => setGitBranch(e.target.value)}
                placeholder={project.gitBranch}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {/* Git Commit */}
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                Commit <span className="text-gray-500">(optional, defaults to HEAD)</span>
              </label>
              <input
                type="text"
                value={gitCommit}
                onChange={(e) => setGitCommit(e.target.value)}
                placeholder="HEAD"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono text-sm"
              />
            </div>

            {/* Config Fields */}
            {Object.keys(configSchema).length > 0 && (
              <div className="border-t border-gray-700 pt-4">
                <h3 className="text-sm font-medium text-gray-300 mb-2">Build Options</h3>
                {Object.entries(configSchema).map(([key, schema]) =>
                  renderConfigField(key, schema)
                )}
              </div>
            )}

            {/* Clean Build Option */}
            <div className="border-t border-gray-700 pt-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cleanBuild}
                  onChange={(e) => setCleanBuild(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
                />
                <div>
                  <span className="text-gray-200">Clean build</span>
                  <p className="text-xs text-gray-500">Wipe workspace before building (full rebuild)</p>
                </div>
              </label>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-gray-700">
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
              className="px-4 py-2 text-gray-300 hover:text-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium disabled:opacity-50 flex items-center gap-2"
            >
              {isLoading && (
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
              Trigger Build
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
