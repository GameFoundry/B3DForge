import { EventEmitter } from 'events';
import type { Socket } from 'socket.io';
import type {
	AgentInfo,
	AgentRegistration,
	AgentStatus,
	BuildAssignment,
	BuildCancelEvent,
} from '@banshee-forge/shared';
import { generateId } from '@banshee-forge/shared';

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
			labels: [...registration.labels],
			maxParallelBuilds: Math.max(1, registration.maxParallelBuilds || 1),
			version: registration.version,
			connectedAt: now,
			lastSeenAt: now,
			activeBuildIds: [],
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
		agent.info.activeBuildIds = [...status.activeBuildIds];
		agent.info.lastSeenAt = new Date().toISOString();
		this.emit('status-changed', agent);
		const isFull = agent.info.activeBuildIds.length >= agent.info.maxParallelBuilds;
		if (wasFull && !isFull) this.emit('available', agent);
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
	 * Find agents that match a configuration's platform + label requirements and have at least one
	 * free slot. Returned in fewest-active-builds order so the dispatcher prefers idle agents first.
	 */
	findEligible(platform: string | undefined, requiredLabels: string[] | undefined): RegisteredAgent[] {
		const wantPlatform = platform ?? 'any';
		const want = requiredLabels ?? [];
		const eligible: RegisteredAgent[] = [];
		for (const agent of this.agents.values()) {
			if (agent.info.activeBuildIds.length >= agent.info.maxParallelBuilds) continue;
			if (wantPlatform !== 'any' && agent.info.platform !== wantPlatform) continue;
			if (!want.every(label => agent.info.labels.includes(label))) continue;
			eligible.push(agent);
		}
		eligible.sort((a, b) => a.info.activeBuildIds.length - b.info.activeBuildIds.length);
		return eligible;
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
}
