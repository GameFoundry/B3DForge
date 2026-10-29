import { useState } from 'react';
import { useServerConfig, useUpdateServerConfig } from '../hooks/useConfig';
import { mcpTokensApi } from '../api/client';
import { TokenManager } from './AgentTokens';

/**
 * MCP section of the settings page: switches the `/mcp` endpoint on or off (applied without a
 * restart), shows how to connect a client and manages the tokens clients authenticate with.
 */
export function McpSettings() {
	const { data: config } = useServerConfig();
	const updateConfig = useUpdateServerConfig();
	const [error, setError] = useState<string | null>(null);

	const enabled = config?.mcp?.enabled ?? true;
	const endpoint = `${window.location.origin}/mcp`;

	const handleToggle = async () => {
		setError(null);
		try {
			await updateConfig.mutateAsync({ mcp: { enabled: !enabled } });
		} catch (err) {
			setError((err as Error).message);
		}
	};

	return (
		<div className="bg-gray-800 rounded-lg p-6">
			<div className="flex items-center justify-between mb-1">
				<h2 className="text-lg font-medium text-gray-100">MCP</h2>
				<label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
					<input
						type="checkbox"
						checked={enabled}
						onChange={handleToggle}
						disabled={!config || updateConfig.isPending}
						className="rounded border-gray-600 bg-gray-700 text-blue-600 focus:ring-blue-500"
					/>
					Enabled
				</label>
			</div>
			<p className="text-sm text-gray-400 mb-4">
				Lets coding agents (Claude Code and other MCP clients) list projects and builds, read build logs and
				test results, and start or cancel builds. Clients authenticate with an MCP token.
			</p>

			{error && (
				<div className="rounded-lg p-3 mb-4 text-sm bg-red-900/30 border border-red-700 text-red-300">{error}</div>
			)}

			<div className="bg-gray-900/50 rounded-lg p-3 mb-4 text-sm">
				<div className="flex justify-between">
					<span className="text-gray-400">Endpoint</span>
					<code className="text-gray-300 font-mono text-xs">{endpoint}</code>
				</div>
				<p className="text-xs text-gray-500 mt-2">Connect Claude Code with:</p>
				<code className="block mt-1 px-2 py-1 bg-gray-900 rounded text-gray-300 text-xs font-mono break-all">
					claude mcp add --transport http --scope user banshee-forge {endpoint} --header "Authorization: Bearer &lt;token&gt;"
				</code>
			</div>

			<TokenManager api={mcpTokensApi} queryKey="mcp-tokens" placeholder="Token name (e.g. claude-workstation)" noun="MCP tokens" />
		</div>
	);
}
