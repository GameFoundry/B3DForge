import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentInfo, AgentPurgeArtifactsResult } from '@banshee-forge/shared';
import { agentsApi } from '../api/client';

/**
 * Disk used by an agent's local build artifacts, with a button to reclaim it.
 *
 * Artifacts are the install tree each build produces. They never leave the agent and nothing
 * reads them back, so they pile up at roughly one tree per build until purged manually.
 */
export function AgentArtifacts({ agent }: { agent: AgentInfo }) {
	const queryClient = useQueryClient();
	const usageKey = ['agents', agent.id, 'artifacts'];

	// Measuring walks the whole artifact tree, so this deliberately doesn't poll and stays fresh
	// for a while — the numbers only move when a build finishes or a purge runs.
	const { data: usage, isLoading, error } = useQuery({
		queryKey: usageKey,
		queryFn: () => agentsApi.getArtifactUsage(agent.id),
		staleTime: 5 * 60_000,
		retry: false,
	});

	const purgeMutation = useMutation({
		mutationFn: () => agentsApi.purgeArtifacts(agent.id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: usageKey }),
	});

	if (isLoading) {
		return <span className="text-xs text-gray-500">Measuring…</span>;
	}

	if (error || !usage) {
		const message = error instanceof Error ? error.message : 'Unavailable';
		return <span className="text-xs text-red-400" title={message}>Unavailable</span>;
	}

	const result = purgeMutation.data;

	return (
		<div className="space-y-1">
			<div className="flex items-center gap-3">
				<span title={usage.buildsRoot}>
					{formatBytes(usage.totalBytes)}
					<span className="text-gray-500 text-xs ml-1">
						({usage.buildCount} build{usage.buildCount === 1 ? '' : 's'})
					</span>
				</span>
				<button
					onClick={() => {
						const message =
							`Delete build artifacts on agent "${agent.name}"?\n\n` +
							`This frees ${formatBytes(usage.purgeableBytes)} across ${usage.purgeableCount} ` +
							`build${usage.purgeableCount === 1 ? '' : 's'}.\n\n` +
							`Build history, logs and test results are kept — only the local install ` +
							`trees are removed. Running builds are skipped.`;
						if (confirm(message)) purgeMutation.mutate();
					}}
					disabled={purgeMutation.isPending || usage.purgeableCount === 0}
					className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 disabled:hover:text-red-400"
				>
					{purgeMutation.isPending ? 'Purging…' : 'Purge'}
				</button>
			</div>

			{purgeMutation.error && (
				<div className="text-xs text-red-400">
					{purgeMutation.error instanceof Error ? purgeMutation.error.message : 'Purge failed'}
				</div>
			)}
			{result && <PurgeSummary result={result} />}
		</div>
	);
}

function PurgeSummary({ result }: { result: AgentPurgeArtifactsResult }) {
	return (
		<div className="text-xs text-gray-400">
			Freed {formatBytes(result.freedBytes)} from {result.deletedCount}{' '}
			build{result.deletedCount === 1 ? '' : 's'}
			{result.skippedBuildIds.length > 0 && (
				<span className="text-gray-500">
					{' '}· skipped {result.skippedBuildIds.length} running
				</span>
			)}
			{result.errors.length > 0 && (
				<span className="text-yellow-500" title={result.errors.join('\n')}>
					{' '}· {result.errors.length} failed
				</span>
			)}
		</div>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KiB', 'MiB', 'GiB', 'TiB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
