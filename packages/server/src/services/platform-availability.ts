import type { KnownAgent, PlatformAvailability, PlatformAgentState } from '@banshee-forge/shared';
import { PLATFORMS } from '@banshee-forge/shared';
import { AgentRegistry } from './agent-registry.js';

/**
 * Combine live agents with the persisted known-agent list into a per-platform view. A platform is
 * `connected` when at least one live agent services it, `offline` when only known-but-disconnected
 * agents do (builds can still be queued and will wait), and `never-seen` otherwise.
 */
export function computePlatformAvailability(
	registry: AgentRegistry,
	knownAgents: KnownAgent[],
): PlatformAvailability[] {
	const live = registry.list();

	return PLATFORMS.map(platform => {
		const agents = new Map<string, PlatformAgentState>();

		for (const known of knownAgents) {
			if (!known.platforms.includes(platform.id)) continue;
			agents.set(known.name, {
				name: known.name,
				connected: false,
				available: false,
				lastSeenAt: known.lastSeenAt,
			});
		}

		for (const agent of live) {
			if (!agent.platforms.includes(platform.id)) continue;
			agents.set(agent.name, {
				name: agent.name,
				connected: true,
				available: agent.available,
				unavailableReason: agent.unavailableReason,
				lastSeenAt: agent.lastSeenAt,
			});
		}

		const list = Array.from(agents.values());
		const status = list.some(a => a.connected)
			? 'connected'
			: list.length > 0 ? 'offline' : 'never-seen';

		return { id: platform.id, label: platform.label, status, agents: list };
	});
}
