import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { io as createSocket, Socket } from 'socket.io-client';
import type { AgentInfo } from '@banshee-forge/shared';
import { agentsApi } from '../api/client';

export function Agents() {
	const queryClient = useQueryClient();
	const { data, isLoading } = useQuery({
		queryKey: ['agents'],
		queryFn: () => agentsApi.list(),
		refetchInterval: 30_000,
	});

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
								<th className="px-4 py-3">Platform</th>
								<th className="px-4 py-3">Hostname</th>
								<th className="px-4 py-3">Labels</th>
								<th className="px-4 py-3">Active</th>
								<th className="px-4 py-3">Connected</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-700">
							{agents.map(agent => (
								<tr key={agent.id} className="text-gray-200">
									<td className="px-4 py-3 font-medium">{agent.name}</td>
									<td className="px-4 py-3 font-mono text-xs">{agent.platform}/{agent.arch}</td>
									<td className="px-4 py-3 font-mono text-xs">{agent.hostname}</td>
									<td className="px-4 py-3 text-xs">
										{agent.labels.length === 0
											? <span className="text-gray-500">—</span>
											: agent.labels.join(', ')}
									</td>
									<td className="px-4 py-3">
										{agent.activeBuildIds.length} / {agent.maxParallelBuilds}
									</td>
									<td className="px-4 py-3 text-xs text-gray-400">
										{new Date(agent.connectedAt).toLocaleString()}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
