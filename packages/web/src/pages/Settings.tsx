import { useState, useEffect } from 'react';
import { useServerConfig, useUpdateServerConfig, useValidateDataPath } from '../hooks/useConfig';
import { AgentTokens } from '../components/AgentTokens';

export function Settings() {
  const { data: config, isLoading } = useServerConfig();
  const updateConfig = useUpdateServerConfig();
  const validatePath = useValidateDataPath();

  const [dataPath, setDataPath] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    message?: string;
  } | null>(null);

  useEffect(() => {
    if (config) {
      setDataPath(config.dataPath);
    }
  }, [config]);

  const handleDataPathChange = (value: string) => {
    setDataPath(value);
    setHasChanges(value !== config?.dataPath);
    setValidationResult(null);
  };

  const handleValidate = async () => {
    try {
      const result = await validatePath.mutateAsync(dataPath);
      setValidationResult({
        valid: result.valid,
        message: result.valid ? 'Path is valid and writable' : result.message,
      });
    } catch (err) {
      setValidationResult({
        valid: false,
        message: (err as Error).message,
      });
    }
  };

  const handleSave = async () => {
    try {
      await updateConfig.mutateAsync({ dataPath });
      setHasChanges(false);
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  const sourceLabel = {
    env: 'Environment Variable',
    file: 'Configuration File',
    default: 'Default',
  }[config?.configSource ?? 'default'];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Settings</h1>
        <p className="text-gray-400 mt-1">Configure server settings</p>
      </div>

      {/* Pending Restart Warning */}
      {config?.pendingRestart && (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-4">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="text-yellow-300 font-medium">Restart Required</span>
          </div>
          <p className="text-yellow-200/70 text-sm mt-1">
            Configuration changes have been saved. Restart the server to apply them.
          </p>
        </div>
      )}

      {/* Data Path Configuration */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-medium text-gray-100 mb-4">Data Storage</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Data Path
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={dataPath}
                onChange={(e) => handleDataPathChange(e.target.value)}
                disabled={config?.configSource === 'env'}
                placeholder="/path/to/data"
                className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <button
                onClick={handleValidate}
                disabled={validatePath.isPending || !dataPath}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-gray-100 rounded disabled:opacity-50 text-sm"
              >
                {validatePath.isPending ? 'Validating...' : 'Validate'}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Directory where projects, builds, and workspaces are stored. Must be an absolute path.
            </p>
          </div>

          {/* Validation Result */}
          {validationResult && (
            <div className={`rounded-lg p-3 ${validationResult.valid ? 'bg-green-900/30 border border-green-700' : 'bg-red-900/30 border border-red-700'}`}>
              <div className="flex items-center gap-2">
                {validationResult.valid ? (
                  <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                )}
                <span className={validationResult.valid ? 'text-green-300' : 'text-red-300'}>
                  {validationResult.message}
                </span>
              </div>
            </div>
          )}

          {/* Config Source Info */}
          <div className="bg-gray-900/50 rounded-lg p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">Configuration Source:</span>
              <span className="text-gray-300">{sourceLabel}</span>
            </div>
            {config?.configSource === 'env' && (
              <p className="text-xs text-gray-500 mt-2">
                Data path is set via the DATA_PATH environment variable. To use the UI settings, remove the environment variable and restart the server.
              </p>
            )}
          </div>

          {/* Save Button */}
          <div className="flex justify-end pt-2">
            <button
              onClick={handleSave}
              disabled={!hasChanges || updateConfig.isPending || config?.configSource === 'env'}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 text-sm flex items-center gap-2"
            >
              {updateConfig.isPending && (
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
              {hasChanges ? 'Save Changes' : 'Saved'}
            </button>
          </div>

          {/* Success Message */}
          {updateConfig.isSuccess && (
            <div className="bg-blue-900/30 border border-blue-700 rounded-lg p-3">
              <p className="text-blue-300 text-sm">
                Configuration saved. Restart the server to apply changes.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Agent Tokens */}
      <AgentTokens />

      {/* Server Info */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-medium text-gray-100 mb-4">Server Information</h2>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-gray-400">Port</dt>
            <dd className="text-gray-300 font-mono">{config?.port}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-400">Current Data Path</dt>
            <dd className="text-gray-300 font-mono text-xs break-all">{config?.dataPath}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
