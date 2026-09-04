import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { io as createSocket, Socket } from 'socket.io-client';
import type { AgentInfo, KnownAgent } from '@banshee-forge/shared';
import { getPlatformLabel } from '@banshee-forge/shared';
import { agentsApi, platformsApi } from '../api/client';
import { AgentArtifacts } from '../components/AgentArtifacts';
import { useKnownAgents } from '../hooks/usePlatforms';

export function Agents() {
	const queryClient = useQueryClient();
	const { data, isLoading } = useQuery({
		queryKey: ['agents'],
		queryFn: () => agentsApi.list(),
		refetchInterval: 30_000,
	});

	const { data: knownAgents } = useKnownAgents();
	const [socket, setSocket] = useState<Socket | null>(null);
	useEffect(() => {
		const s = createSocket({ withCredentials: true });
		s.on('agent:connected', () => queryClient.invalidateQueries({ queryKey: ['agents'] }));
		s.on('agent:disconnected', () => queryClient.invalidateQueries({ queryKey: ['agents'] }));
		s.on('agent:status-changed', (info: AgentInfo) => {
			queryClient.setQueryData<{ agents: AgentInfo[] }>(['agents'], (prev) => {
				if (!prev) return prev;
				const idx = prev.agents.findIndex(a => a.id === info.id);
				if (idx === -1) return { agents: [...prev.agents, info] };
				const next = [...prev.agents];
				next[idx] = info;
				return { agents: next };
			});
		});
		setSocket(s);
		return () => { s.disconnect(); };
	}, [queryClient]);

	useEffect(() => {
		return () => { socket?.disconnect(); };
	}, [socket]);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
			</div>
		);
	}

	const agents = data?.agents ?? [];
	const offlineAgents = (knownAgents ?? []).filter(known => !agents.some(a => a.name === known.name));

	const handleForget = async (known: KnownAgent) => {
		if (!confirm(`Forget agent "${known.name}"? Its platforms will no longer be offered while it is offline.`)) return;
		try {
			await platformsApi.forgetAgent(known.name);
			queryClient.invalidateQueries({ queryKey: ['known-agents'] });
			queryClient.invalidateQueries({ queryKey: ['platforms'] });
		} catch (err) {
			console.error('Failed to forget agent:', err);
		}
	};

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-bold text-gray-100">Agents</h1>
				<p className="text-gray-400 mt-1">Build agents currently connected to the orchestrator</p>
			</div>

			{agents.length === 0 ? (
				<div className="bg-gray-800 rounded-lg p-6">
					<p className="text-gray-400 text-sm">
						No agents are connected. Builds will queue until an agent registers.
					</p>
					<p className="text-gray-500 text-xs mt-2">
						Generate an agent token in <span className="text-gray-300">Settings → Agent Tokens</span> and run the agent process with the token.
					</p>
				</div>
			) : (
				<div className="bg-gray-800 rounded-lg overflow-hidden">
					<table className="w-full text-sm">
						<thead className="bg-gray-900/50 text-left text-xs uppercase tracking-wider text-gray-400">
							<tr>
								<th className="px-4 py-3">Name</th>
								<th className="px-4 py-3">Host</th>
								<th className="px-4 py-3">Builds for</th>
								<th className="px-4 py-3">Hostname</th>
								<th className="px-4 py-3">Labels</th>
								<th className="px-4 py-3">State</th>
								<th className="px-4 py-3">Active</th>
								<th className="px-4 py-3">Connected</th>
								<th className="px-4 py-3">Artifacts</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-700">
							{agents.map(agent => (
								<tr key={agent.id} className="text-gray-200">
									<td className="px-4 py-3 font-medium">{agent.name}</td>
									<td className="px-4 py-3 font-mono text-xs">{agent.platform}/{agent.arch}</td>
									<td className="px-4 py-3 text-xs">{agent.platforms.map(getPlatformLabel).join(', ')}</td>
									<td className="px-4 py-3 font-mono text-xs">{agent.hostname}</td>
									<td className="px-4 py-3 text-xs">
										{agent.labels.length === 0
											? <span className="text-gray-500">—</span>
											: agent.labels.join(', ')}
									</td>
									<td className="px-4 py-3 text-xs">
										{agent.available
											? <span className="px-1.5 py-0.5 rounded bg-green-900/40 text-green-300">available</span>
											: <span className="px-1.5 py-0.5 rounded bg-yellow-900/40 text-yellow-300" title={agent.unavailableReason}>
												{agent.unavailableReason ?? 'unavailable'}
											</span>}
									</td>
									<td className="px-4 py-3">
										{agent.activeBuildIds.length} / {agent.maxParallelBuilds}
									</td>
									<td className="px-4 py-3 text-xs text-gray-400">
										{new Date(agent.connectedAt).toLocaleString()}
									</td>
									<td className="px-4 py-3 text-sm">
										<AgentArtifacts agent={agent} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{offlineAgents.length > 0 && (
				<div>
					<h2 className="text-lg font-semibold text-gray-100">Offline agents</h2>
					<p className="text-gray-400 text-sm mt-1 mb-3">
						Agents seen before but not connected now. Builds for their platforms can still be queued and wait until they reconnect.
					</p>
					<div className="bg-gray-800 rounded-lg overflow-hidden">
						<table className="w-full text-sm">
							<thead className="bg-gray-900/50 text-left text-xs uppercase tracking-wider text-gray-400">
								<tr>
									<th className="px-4 py-3">Name</th>
									<th className="px-4 py-3">Host</th>
									<th className="px-4 py-3">Builds for</th>
									<th className="px-4 py-3">Hostname</th>
									<th className="px-4 py-3">Last seen</th>
									<th className="px-4 py-3"></th>
								</tr>
							</thead>
							<tbody className="divide-y divide-gray-700">
								{offlineAgents.map(known => (
									<tr key={known.name} className="text-gray-300">
										<td className="px-4 py-3 font-medium">{known.name}</td>
										<td className="px-4 py-3 font-mono text-xs">{known.platform}/{known.arch}</td>
										<td className="px-4 py-3 text-xs">{known.platforms.map(getPlatformLabel).join(', ')}</td>
										<td className="px-4 py-3 font-mono text-xs">{known.hostname}</td>
										<td className="px-4 py-3 text-xs text-gray-400">{new Date(known.lastSeenAt).toLocaleString()}</td>
										<td className="px-4 py-3 text-right">
											<button
												onClick={() => handleForget(known)}
												className="text-xs text-gray-400 hover:text-red-400"
											>
												Forget
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			)}
		</div>
	);
}
