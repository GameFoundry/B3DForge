import { io as createSocket, Socket } from 'socket.io-client';
import type {
	AgentRegistration,
	AgentStatus,
	AgentLogEvent,
	AgentPhaseEvent,
	AgentCompleteEvent,
	AgentErrorEvent,
	BuildAssignment,
	BuildCancelEvent,
} from '@banshee-forge/shared';

export interface OrchestratorClientEvents {
	'connect': () => void;
	'disconnect': (reason: string) => void;
	'register-ack': (response: { ok: boolean; agentId?: string; error?: string }) => void;
	'build:assign': (payload: BuildAssignment) => void;
	'build:cancel': (payload: BuildCancelEvent) => void;
}

/**
 * Thin wrapper over `socket.io-client` for the agent's connection to the orchestrator's
 * `/agents` namespace. Connection authenticated with the agent's bearer token; reconnection
 * left to the underlying client.
 */
export class OrchestratorClient {
	private socket: Socket;
	private registered = false;

	constructor(url: string, token: string) {
		// socket.io-client appends `/agents` to the URL via the namespace path.
		this.socket = createSocket(`${url.replace(/\/$/, '')}/agents`, {
			auth: { token },
			reconnection: true,
			reconnectionDelay: 1000,
			reconnectionDelayMax: 30000,
			transports: ['websocket', 'polling'],
		});
	}

	on<K extends keyof OrchestratorClientEvents>(event: K, listener: OrchestratorClientEvents[K]): void {
		this.socket.on(event, listener as never);
	}

	register(payload: AgentRegistration): void {
		this.socket.emit('agent:register', payload);
	}

	get isRegistered(): boolean { return this.registered; }
	markRegistered(): void { this.registered = true; }

	sendStatus(payload: AgentStatus): void {
		this.socket.emit('agent:status', payload);
	}

	sendLog(event: AgentLogEvent): void {
		this.socket.emit('agent:log', event);
	}

	sendPhase(event: AgentPhaseEvent): void {
		this.socket.emit('agent:phase', event);
	}

	sendComplete(event: AgentCompleteEvent): void {
		this.socket.emit('agent:complete', event);
	}

	sendError(event: AgentErrorEvent): void {
		this.socket.emit('agent:error', event);
	}

	disconnect(): void {
		this.socket.disconnect();
	}
}
