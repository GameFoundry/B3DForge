import { EventEmitter } from 'events';
import type { Socket } from 'socket.io';
import type {
	AgentAck,
	AgentArtifactUsage,
	AgentInfo,
	AgentPurgeArtifactsResult,
	AgentRegistration,
	AgentStatus,
	BuildAssignment,
	BuildCancelEvent,
} from '@banshee-forge/shared';
import { generateId } from '@banshee-forge/shared';

/**
 * How long to wait for an agent to answer a `maintenance:*` request. Generous because both
 * measuring and purging walk the full artifact tree, which is tens of gigabytes.
 */
const MAINTENANCE_TIMEOUT_MS = 10 * 60 * 1000;

/** A live agent connection, combining its declared info with the underlying socket. */
export interface RegisteredAgent {
	info: AgentInfo;
	socket: Socket;
	/** ID of the agent token used at handshake — for audit logging. */
	tokenId: string;
}

export interface AgentRegistryEvents {
	'connected': (agent: RegisteredAgent) => void;
	'disconnected': (agent: RegisteredAgent) => void;
	/** Fired whenever an agent's status (active builds, load) changes. */
	'status-changed': (agent: RegisteredAgent) => void;
	/** Fired when an agent has a free slot, prompting the dispatcher to consider new work. */
	'available': (agent: RegisteredAgent) => void;
}

export declare interface AgentRegistry {
	on<K extends keyof AgentRegistryEvents>(event: K, listener: AgentRegistryEvents[K]): this;
	emit<K extends keyof AgentRegistryEvents>(event: K, ...args: Parameters<AgentRegistryEvents[K]>): boolean;
}

export class AgentRegistry extends EventEmitter {
	private agents: Map<string, RegisteredAgent> = new Map();

	register(socket: Socket, registration: AgentRegistration, tokenId: string): RegisteredAgent {
		const id = generateId('agent');
		const now = new Date().toISOString();
		const info: AgentInfo = {
			id,
			name: registration.name,
			platform: registration.platform,
			arch: registration.arch,
			hostname: registration.hostname,
			platforms: registration.platforms?.length ? [...registration.platforms] : [registration.platform],
			labels: [...registration.labels],
			maxParallelBuilds: Math.max(1, registration.maxParallelBuilds || 1),
			version: registration.version,
			connectedAt: now,
			lastSeenAt: now,
			activeBuildIds: [],
			available: true,
		};
		const agent: RegisteredAgent = { info, socket, tokenId };
		this.agents.set(id, agent);
		this.emit('connected', agent);
		this.emit('available', agent); // brand-new agent is by definition idle
		return agent;
	}

	unregister(agentId: string): RegisteredAgent | null {
		const agent = this.agents.get(agentId) ?? null;
		if (!agent) return null;
		this.agents.delete(agentId);
		this.emit('disconnected', agent);
		return agent;
	}

	updateStatus(agentId: string, status: AgentStatus): RegisteredAgent | null {
		const agent = this.agents.get(agentId);
		if (!agent) return null;
		const wasFull = agent.info.activeBuildIds.length >= agent.info.maxParallelBuilds;
		const wasAvailable = agent.info.available;
		agent.info.activeBuildIds = [...status.activeBuildIds];
		agent.info.lastSeenAt = new Date().toISOString();
		agent.info.available = status.available ?? true;
		agent.info.unavailableReason = agent.info.available ? undefined : status.unavailableReason;
		this.emit('status-changed', agent);
		const isFull = agent.info.activeBuildIds.length >= agent.info.maxParallelBuilds;
		if ((wasFull && !isFull) || (!wasAvailable && agent.info.available)) this.emit('available', agent);
		return agent;
	}

	/** Optimistic local update when the orchestrator assigns a build before the agent reports back. */
	noteAssignment(agentId: string, buildId: string): void {
		const agent = this.agents.get(agentId);
		if (!agent) return;
		if (!agent.info.activeBuildIds.includes(buildId)) {
			agent.info.activeBuildIds.push(buildId);
			this.emit('status-changed', agent);
		}
	}

	noteCompletion(agentId: string, buildId: string): void {
		const agent = this.agents.get(agentId);
		if (!agent) return;
		const before = agent.info.activeBuildIds.length;
		agent.info.activeBuildIds = agent.info.activeBuildIds.filter(id => id !== buildId);
		if (agent.info.activeBuildIds.length !== before) {
			this.emit('status-changed', agent);
			if (agent.info.activeBuildIds.length < agent.info.maxParallelBuilds) {
				this.emit('available', agent);
			}
		}
	}

	get(agentId: string): RegisteredAgent | null {
		return this.agents.get(agentId) ?? null;
	}

	list(): AgentInfo[] {
		return Array.from(this.agents.values()).map(a => a.info);
	}

	/**
	 * Find agents that service a build's target platform, carry every required label, report
	 * themselves available, and have at least one free slot. Returned in fewest-active-builds
	 * order so the dispatcher prefers idle agents first.
	 */
	findEligible(platform: string, requiredLabels: string[] | undefined): RegisteredAgent[] {
		const want = requiredLabels ?? [];
		const eligible: RegisteredAgent[] = [];
		for (const agent of this.agents.values()) {
			if (!agent.info.available) continue;
			if (agent.info.activeBuildIds.length >= agent.info.maxParallelBuilds) continue;
			if (!agent.info.platforms.includes(platform)) continue;
			if (!want.every(label => agent.info.labels.includes(label))) continue;
			eligible.push(agent);
		}
		eligible.sort((a, b) => a.info.activeBuildIds.length - b.info.activeBuildIds.length);
		return eligible;
	}

	/**
	 * Explain why no agent was eligible for a platform, for display on the queued build. Checks
	 * the same conditions as {@link findEligible} in order of severity.
	 */
	describeIneligibility(platform: string, requiredLabels: string[] | undefined): string {
		const want = requiredLabels ?? [];
		const servicing = Array.from(this.agents.values()).filter(a => a.info.platforms.includes(platform));
		if (servicing.length === 0) return `No connected agent can build ${platform}`;

		const labelled = servicing.filter(a => want.every(label => a.info.labels.includes(label)));
		if (labelled.length === 0) return `No connected ${platform} agent has labels: ${want.join(', ')}`;

		const unavailable = labelled.filter(a => !a.info.available);
		if (unavailable.length === labelled.length) {
			const reason = unavailable[0].info.unavailableReason ?? 'agent unavailable';
			return `Waiting for ${unavailable[0].info.name}: ${reason}`;
		}

		return `All ${platform} agents are busy`;
	}

	sendAssignment(agentId: string, payload: BuildAssignment): boolean {
		const agent = this.agents.get(agentId);
		if (!agent) return false;
		agent.socket.emit('build:assign', payload);
		return true;
	}

	sendCancel(agentId: string, payload: BuildCancelEvent): boolean {
		const agent = this.agents.get(agentId);
		if (!agent) return false;
		agent.socket.emit('build:cancel', payload);
		return true;
	}

	/** Measure the disk taken by the agent's local per-build artifact directories. */
	requestArtifactUsage(agentId: string): Promise<AgentArtifactUsage> {
		return this.request<AgentArtifactUsage>(agentId, 'maintenance:artifact-usage');
	}

	/**
	 * Delete the agent's artifact directories for every build that isn't currently running.
	 * Artifacts are never uploaded or served, so this only reclaims disk — no build history,
	 * log or test result is affected.
	 */
	purgeArtifacts(agentId: string): Promise<AgentPurgeArtifactsResult> {
		return this.request<AgentPurgeArtifactsResult>(agentId, 'maintenance:purge-artifacts');
	}

	/**
	 * Send a request to an agent and await its acknowledgement. Rejects if the agent isn't
	 * connected, reports an error, or doesn't answer within {@link MAINTENANCE_TIMEOUT_MS}.
	 */
	private async request<T>(agentId: string, event: string): Promise<T> {
		const agent = this.agents.get(agentId);
		if (!agent) throw new Error('Agent is not connected');

		const response = await agent.socket
			.timeout(MAINTENANCE_TIMEOUT_MS)
			.emitWithAck(event, {}) as AgentAck<T> | undefined;

		if (!response) throw new Error('Agent returned an empty response');
		if (!response.ok) throw new Error(response.error);
		return response.data;
	}
}
