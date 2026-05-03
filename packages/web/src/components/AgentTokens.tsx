import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agentTokensApi } from '../api/client';

export function AgentTokens() {
	const queryClient = useQueryClient();
	const { data, isLoading } = useQuery({
		queryKey: ['agent-tokens'],
		queryFn: () => agentTokensApi.list(),
	});
	const [newName, setNewName] = useState('');
	const [createdSecret, setCreatedSecret] = useState<{ name: string; plaintext: string } | null>(null);

	const createMutation = useMutation({
		mutationFn: (name: string) => agentTokensApi.create(name),
		onSuccess: (created) => {
			setCreatedSecret({ name: created.name, plaintext: created.plaintext });
			setNewName('');
			queryClient.invalidateQueries({ queryKey: ['agent-tokens'] });
		},
	});

	const revokeMutation = useMutation({
		mutationFn: (id: string) => agentTokensApi.revoke(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-tokens'] }),
	});

	const handleCreate = () => {
		const name = newName.trim();
		if (!name) return;
		createMutation.mutate(name);
	};

	return (
		<div className="bg-gray-800 rounded-lg p-6">
			<h2 className="text-lg font-medium text-gray-100 mb-1">Agent Tokens</h2>
			<p className="text-gray-400 text-sm mb-4">
				Bearer tokens used by remote build agents to authenticate with the orchestrator.
			</p>

			<div className="flex gap-2 mb-4">
				<input
					type="text"
					value={newName}
					onChange={(e) => setNewName(e.target.value)}
					placeholder="Token name (e.g. linux-build-vm)"
					className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 text-sm"
				/>
				<button
					onClick={handleCreate}
					disabled={createMutation.isPending || !newName.trim()}
					className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 text-sm"
				>
					{createMutation.isPending ? 'Creating...' : 'Create token'}
				</button>
			</div>

			{createdSecret && (
				<div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-3 mb-4">
					<p className="text-yellow-300 text-sm font-medium">
						Token "{createdSecret.name}" created. Copy it now — it will not be shown again.
					</p>
					<code className="block mt-2 px-2 py-1 bg-gray-900 rounded text-yellow-200 text-xs font-mono break-all">
						{createdSecret.plaintext}
					</code>
					<button
						onClick={() => setCreatedSecret(null)}
						className="text-xs text-yellow-300/70 hover:text-yellow-200 mt-2"
					>
						Dismiss
					</button>
				</div>
			)}

			{isLoading ? (
				<div className="text-gray-400 text-sm">Loading...</div>
			) : (data?.tokens ?? []).length === 0 ? (
				<p className="text-gray-500 text-sm">No agent tokens yet.</p>
			) : (
				<table className="w-full text-sm">
					<thead className="text-left text-xs uppercase tracking-wider text-gray-400">
						<tr>
							<th className="py-2">Name</th>
							<th className="py-2">Created</th>
							<th className="py-2">Last used</th>
							<th className="py-2"></th>
						</tr>
					</thead>
					<tbody className="divide-y divide-gray-700">
						{(data?.tokens ?? []).map(token => (
							<tr key={token.id} className="text-gray-200">
								<td className="py-2 font-medium">{token.name}</td>
								<td className="py-2 text-xs text-gray-400">{new Date(token.createdAt).toLocaleString()}</td>
								<td className="py-2 text-xs text-gray-400">
									{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : '—'}
								</td>
								<td className="py-2 text-right">
									<button
										onClick={() => {
											if (confirm(`Revoke token "${token.name}"?`)) revokeMutation.mutate(token.id);
										}}
										disabled={revokeMutation.isPending}
										className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
									>
										Revoke
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}
