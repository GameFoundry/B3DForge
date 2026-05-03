import type { Server as SocketServer, Socket } from 'socket.io';
import type {
	AgentRegistration,
	AgentStatus,
	AgentLogEvent,
	AgentPhaseEvent,
	AgentCompleteEvent,
	AgentErrorEvent,
} from '@banshee-forge/shared';
import { AgentTokensRepository } from '../auth/agent-tokens-repository.js';
import { AgentRegistry, RegisteredAgent } from '../services/agent-registry.js';
import { AgentDispatcher } from '../services/agent-dispatcher.js';
import { BuildOrchestrator } from '../services/build-orchestrator.js';

const NAMESPACE = '/agents';

/**
 * Wire up the `/agents` Socket.IO namespace. Agents authenticate with their bearer token at
 * handshake; once authenticated they emit `agent:register` and start the bidirectional event
 * stream defined by the protocol.
 */
export function setupAgentNamespace(
	io: SocketServer,
	tokensRepo: AgentTokensRepository,
	registry: AgentRegistry,
	dispatcher: AgentDispatcher,
	orchestrator: BuildOrchestrator,
): void {
	const ns = io.of(NAMESPACE);

	ns.use(async (socket, next) => {
		try {
			const auth = socket.handshake.auth as { token?: string } | undefined;
			const headerAuth = socket.handshake.headers.authorization;
			const fromHeader = typeof headerAuth === 'string' && headerAuth.startsWith('Bearer ')
				? headerAuth.slice('Bearer '.length).trim()
				: undefined;
			const plaintext = (auth?.token ?? fromHeader ?? '').trim();
			if (!plaintext) return next(new Error('Unauthorized: missing agent token'));

			const token = await tokensRepo.findByPlaintext(plaintext);
			if (!token) return next(new Error('Unauthorized: invalid agent token'));

			void tokensRepo.updateLastUsed(token.id);
			(socket.data as Record<string, unknown>).tokenId = token.id;
			(socket.data as Record<string, unknown>).tokenName = token.name;
			next();
		} catch (err) {
			next(err as Error);
		}
	});

	ns.on('connection', (socket: Socket) => {
		const tokenId = (socket.data as { tokenId?: string }).tokenId;
		const tokenName = (socket.data as { tokenName?: string }).tokenName;
		console.log(`Agent socket connected: ${socket.id} (token: ${tokenName ?? '?'})`);

		let registered: RegisteredAgent | null = null;

		socket.on('agent:register', (registration: AgentRegistration) => {
			if (registered) {
				socket.emit('agent:register-ack', { ok: false, error: 'Already registered' });
				return;
			}
			if (!tokenId) {
				socket.emit('agent:register-ack', { ok: false, error: 'No token in session' });
				return;
			}
			try {
				registered = registry.register(socket, registration, tokenId);
				socket.emit('agent:register-ack', { ok: true, agentId: registered.info.id });
				// Broadcast to web clients so dashboards refresh.
				io.emit('agent:connected', registered.info);
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Registration failed';
				socket.emit('agent:register-ack', { ok: false, error: message });
			}
		});

		socket.on('agent:status', (payload: AgentStatus) => {
			if (!registered) return;
			const updated = registry.updateStatus(registered.info.id, payload);
			if (updated) io.emit('agent:status-changed', updated.info);
		});

		socket.on('agent:log', (event: AgentLogEvent) => {
			void orchestrator.onAgentLog(event);
		});

		socket.on('agent:phase', (event: AgentPhaseEvent) => {
			void orchestrator.onAgentPhase(event);
		});

		socket.on('agent:complete', (event: AgentCompleteEvent) => {
			(async () => {
				await orchestrator.onAgentComplete(event);
				dispatcher.finalizeAssignment(event.buildId);
			})().catch(err => console.error('Failed to handle agent:complete:', err));
		});

		socket.on('agent:error', (event: AgentErrorEvent) => {
			(async () => {
				const slug = dispatcher.getProjectForBuild(event.buildId);
				const agentId = dispatcher.getAgentForBuild(event.buildId);
				await orchestrator.onAgentError(event, slug, agentId);
				dispatcher.finalizeAssignment(event.buildId);
			})().catch(err => console.error('Failed to handle agent:error:', err));
		});

		socket.on('disconnect', () => {
			console.log(`Agent socket disconnected: ${socket.id}`);
			if (registered) {
				const removed = registry.unregister(registered.info.id);
				if (removed) io.emit('agent:disconnected', removed.info);
			}
		});
	});
}
