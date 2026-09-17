import { useState, useEffect } from 'react';
import { useServerConfig, useUpdateServerConfig } from '../hooks/useConfig';

/**
 * Deployment section of the settings page: where the credentials file lives on the server.
 * Applied without a restart.
 */
export function DeploySettings() {
  const { data: config } = useServerConfig();
  const updateConfig = useUpdateServerConfig();

  const [credentialsFile, setCredentialsFile] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (config?.deploy) setCredentialsFile(config.deploy.credentialsFile ?? '');
  }, [config]);

  const hasChanges = !!config && credentialsFile.trim() !== (config.deploy?.credentialsFile ?? '');

  const handleSave = async () => {
    setMessage(null);
    try {
      const result = await updateConfig.mutateAsync({ deploy: { credentialsFile: credentialsFile.trim() } });
      setMessage({ ok: true, text: result.message });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h2 className="text-lg font-medium text-gray-100 mb-1">Deployment</h2>
      <p className="text-sm text-gray-400 mb-4">
        A deployment runs the build's <code>deploy.sh</code> on this server and may push promoted branches.
        Both read credentials from a file that stays on the server's disk.
      </p>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Credentials File</label>
          <input
            type="text"
            value={credentialsFile}
            onChange={(e) => setCredentialsFile(e.target.value)}
            placeholder="D:\\BansheeForgeData\\deploy-credentials.txt"
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">
            Absolute path of a <code>key=value</code> file. The server reads only <code>GIT_TOKEN</code> (and optionally <code>GIT_USER</code>)
            from it, for pushing promoted branches and pin updates over HTTPS. Every other key is passed untouched to <code>deploy.sh</code>
            as <code>DEPLOY_CREDENTIALS_FILE</code> (for Banshee: <code>B3D_UPLOAD_BACKEND</code>, <code>B3D_FTP_*</code> or <code>B3D_R2_*</code>).
            Its contents are never sent to the browser.
          </p>
          {config?.deploy?.credentialsFile && (
            <p className={`text-xs mt-1 ${config.credentialsFileExists ? 'text-green-400' : 'text-red-400'}`}>
              {config.credentialsFileExists ? 'File found on the server.' : 'File not found on the server; deployments that need credentials will fail.'}
            </p>
          )}
        </div>

        <div className="flex justify-end pt-2">
          <button
            onClick={handleSave}
            disabled={!hasChanges || updateConfig.isPending}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 text-sm"
          >
            {updateConfig.isPending ? 'Saving...' : hasChanges ? 'Save Deployment Settings' : 'Saved'}
          </button>
        </div>

        {message && (
          <div className={`rounded-lg p-3 text-sm ${message.ok ? 'bg-blue-900/30 border border-blue-700 text-blue-300' : 'bg-red-900/30 border border-red-700 text-red-300'}`}>
            {message.text}
          </div>
        )}
      </div>
    </div>
  );
}
