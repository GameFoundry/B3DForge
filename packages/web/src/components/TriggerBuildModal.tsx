import { useState, useMemo, useEffect } from 'react';
import type { Project, CreateBuildInput, ConfigSchema, ProjectConfig, BuildConfiguration, PlatformSelectionState, PinInspection } from '@banshee-forge/shared';
import { PLATFORMS, initialPlatformSelection, reconcilePlatformSelection, togglePlatformSelection } from '@banshee-forge/shared';
import { usePlatforms } from '../hooks/usePlatforms';
import { projectsApi, PinConflictError } from '../api/client';
import { PlatformSelector } from './PlatformSelector';

/** State of the submodule-pin check that runs between pressing Trigger and creating the builds. */
type PinCheck =
  | { phase: 'idle' }
  | { phase: 'inspecting' }
  | { phase: 'review'; inspection: PinInspection; input: CreateBuildInput; message?: string }
  | { phase: 'updating'; inspection: PinInspection; input: CreateBuildInput }
  | { phase: 'error'; input: CreateBuildInput; message: string };

/** Platforms a configuration may be built for: its own list, or every platform when unset. */
function supportedPlatforms(configuration: BuildConfiguration | undefined): string[] {
  const declared = configuration?.platforms;
  return declared && declared.length > 0 ? declared : PLATFORMS.map(p => p.id);
}

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
  const [autoDeploy, setAutoDeploy] = useState(false);
  const [pinCheck, setPinCheck] = useState<PinCheck>({ phase: 'idle' });
  const { data: availability } = usePlatforms();

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

  // Default the branch to the configuration's override (falling back to the
  // project default) whenever the selected configuration changes.
  useEffect(() => {
    setGitBranch(selectedConfig?.gitBranch || project.gitBranch);
  }, [selectedConfig, project.gitBranch]);

  // Platforms: default to every supported platform that has an agent (live or remembered),
  // re-evaluated when the configuration changes. The reducer keeps a hand-edited selection
  // intact across the periodic availability refresh, which used to reset it to the defaults.
  const supported = useMemo(() => supportedPlatforms(selectedConfig), [selectedConfig]);
  const [selection, setSelection] = useState<PlatformSelectionState>(() =>
    initialPlatformSelection({ configurationId: selectedConfigId, supported, availability }));
  useEffect(() => {
    setSelection(prev => reconcilePlatformSelection(prev, { configurationId: selectedConfigId, supported, availability }));
  }, [selectedConfigId, supported, availability]);
  const platforms = selection.selected;
  const handlePlatformsChange = (next: string[]) => {
    setSelection(prev => {
      let state = prev;
      for (const id of next) if (!state.selected.includes(id)) state = togglePlatformSelection(state, id, true);
      for (const id of state.selected) if (!next.includes(id)) state = togglePlatformSelection(state, id, false);
      return state;
    });
  };

  /**
   * Submodules are built at the commits the root commit pins, so before creating builds the
   * pins are compared with the heads of the submodules' branches. Stale pins are shown with a
   * choice: push pin commits first (children first, plain pushes) or build as pinned.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (platforms.length === 0) return;

    const input: CreateBuildInput = {
      configurationId: selectedConfigId || undefined,
      platforms,
      gitBranch,
      config,
      cleanBuild,
      autoDeploy,
    };

    if (gitCommit.trim())
      input.gitCommit = gitCommit.trim();

    setPinCheck({ phase: 'inspecting' });
    try {
      const inspection = await projectsApi.inspectPins(project.slug, gitBranch, input.gitCommit);
      if (inspection.submodules.some(s => s.stale)) {
        setPinCheck({ phase: 'review', inspection, input });
        return;
      }
      setPinCheck({ phase: 'idle' });
      onTrigger({ ...input, gitCommit: inspection.rootCommit });
    } catch (err) {
      setPinCheck({ phase: 'error', input, message: err instanceof Error ? err.message : String(err) });
    }
  };

  const buildAsPinned = () => {
    if (pinCheck.phase !== 'review') return;
    const { inspection, input } = pinCheck;
    setPinCheck({ phase: 'idle' });
    onTrigger({ ...input, gitCommit: inspection.rootCommit });
  };

  const updatePinsAndBuild = async () => {
    if (pinCheck.phase !== 'review') return;
    const { inspection, input } = pinCheck;
    setPinCheck({ phase: 'updating', inspection, input });
    try {
      const result = await projectsApi.updatePins(project.slug, { branch: inspection.branch, expectedRootCommit: inspection.rootCommit });
      setPinCheck({ phase: 'idle' });
      onTrigger({ ...input, gitCommit: result.rootCommit });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof PinConflictError) {
        // Someone pushed meanwhile: show the fresh state and let the user decide again.
        try {
          const fresh = await projectsApi.inspectPins(project.slug, inspection.branch, input.gitCommit);
          setPinCheck({ phase: 'review', inspection: fresh, input, message });
          return;
        } catch { /* fall through to the error state */ }
      }
      setPinCheck({ phase: 'error', input, message });
    }
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

  const busy = isLoading || pinCheck.phase === 'inspecting' || pinCheck.phase === 'updating';

  if (pinCheck.phase === 'review' || pinCheck.phase === 'updating' || pinCheck.phase === 'error') {
    const inspection = pinCheck.phase === 'error' ? null : pinCheck.inspection;
    const stale = inspection?.submodules.filter(s => s.stale) ?? [];
    const explicitCommit = !!pinCheck.input.gitCommit && pinCheck.input.gitCommit !== inspection?.rootCommit;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between p-4 border-b border-gray-700 sticky top-0 bg-gray-800">
            <h2 className="text-lg font-semibold text-gray-100">{inspection ? 'Submodule pins are behind' : 'Could not check submodule pins'}</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-200" disabled={busy}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="p-4 space-y-4">
            {pinCheck.phase === 'error' && (
              <p className="text-sm text-red-300 whitespace-pre-wrap">{pinCheck.message}</p>
            )}
            {inspection && (
              <>
                <p className="text-sm text-gray-300">
                  On <span className="font-mono">{inspection.branch}</span> ({inspection.rootCommit.slice(0, 7)}) these submodules are pinned behind the head of their branch.
                  Builds use the pinned commits unless the pins are updated first.
                </p>
                {pinCheck.phase === 'review' && pinCheck.message && (
                  <p className="text-sm text-yellow-300">{pinCheck.message}</p>
                )}
                <ul className="space-y-1 text-sm">
                  {stale.map(pin => (
                    <li key={pin.path} className="flex items-baseline gap-2" style={{ paddingLeft: `${(pin.depth - 1) * 1.25}rem` }}>
                      <span className="font-medium text-gray-200">{pin.name}</span>
                      <span className="font-mono text-xs text-gray-500">{pin.pinned.slice(0, 7)}</span>
                      <span className="text-gray-500 text-xs">→</span>
                      <span className="font-mono text-xs text-blue-400">{pin.head?.slice(0, 7)}</span>
                      <span className="text-xs text-gray-500">({pin.branch})</span>
                    </li>
                  ))}
                </ul>
                {explicitCommit && (
                  <p className="text-xs text-gray-500">A specific commit was requested, so the pins cannot be updated for this build.</p>
                )}
              </>
            )}
            <div className="flex justify-end gap-3 pt-2 border-t border-gray-700">
              <button type="button" onClick={() => setPinCheck({ phase: 'idle' })} disabled={busy} className="px-4 py-2 text-gray-300 hover:text-gray-100 disabled:opacity-50">
                Back
              </button>
              {pinCheck.phase === 'error' ? (
                <button type="button" onClick={() => { const input = pinCheck.input; setPinCheck({ phase: 'idle' }); onTrigger(input); }} disabled={busy} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium disabled:opacity-50">
                  Build anyway
                </button>
              ) : (
                <>
                  <button type="button" onClick={buildAsPinned} disabled={busy} className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded font-medium disabled:opacity-50">
                    Build as pinned
                  </button>
                  <button type="button" onClick={updatePinsAndBuild} disabled={busy || explicitCommit} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium disabled:opacity-50">
                    {pinCheck.phase === 'updating' ? 'Updating pins...' : 'Update pins and build'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-gray-700 sticky top-0 bg-gray-800">
          <h2 className="text-lg font-semibold text-gray-100">Trigger Build</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200"
            disabled={busy}
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

            {/* Platforms */}
            <div>
              <label className="block text-sm text-gray-400 mb-1">Platforms</label>
              <PlatformSelector
                value={platforms}
                onChange={handlePlatformsChange}
                allowed={supported}
                availability={availability}
              />
              <p className="text-xs text-gray-500 mt-1">
                One build is queued per platform. A build for an offline agent waits until it reconnects.
              </p>
              {selection.removed.length > 0 && (
                <p className="text-xs text-yellow-500 mt-1">
                  Dropped {selection.removed.join(', ')}: not supported by this configuration.
                </p>
              )}
            </div>

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

            {/* Auto deploy */}
            <div>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoDeploy}
                  onChange={(e) => setAutoDeploy(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
                />
                <div>
                  <span className="text-gray-200">Auto deploy on success</span>
                  <p className="text-xs text-gray-500">
                    Deploy every selected platform once all of them built and passed tests; skipped if any fails.
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-gray-700">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-4 py-2 text-gray-300 hover:text-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || platforms.length === 0}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium disabled:opacity-50 flex items-center gap-2"
            >
              {busy && (
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
              {pinCheck.phase === 'inspecting' ? 'Checking pins...' : platforms.length > 1 ? `Trigger ${platforms.length} Builds` : 'Trigger Build'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
