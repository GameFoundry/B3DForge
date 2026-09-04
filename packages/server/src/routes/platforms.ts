import { Router } from 'express';
import { AgentRegistry } from '../services/agent-registry.js';
import { KnownAgentsRepository } from '../repositories/known-agents-repository.js';
import { computePlatformAvailability } from '../services/platform-availability.js';
import { AuditLog } from '../auth/audit-log.js';

export function createPlatformRoutes(
	registry: AgentRegistry,
	knownAgents: KnownAgentsRepository,
	auditLog?: AuditLog,
): Router {
	const router = Router();

	// GET /api/v1/platforms — every known platform with the agents able to build it
	router.get('/platforms', async (_req, res, next) => {
		try {
			const known = await knownAgents.list();
			res.json({ platforms: computePlatformAvailability(registry, known) });
		} catch (err) {
			next(err);
		}
	});

	// GET /api/v1/known-agents — agents that have registered at least once, online or not
	router.get('/known-agents', async (_req, res, next) => {
		try {
			res.json({ agents: await knownAgents.list() });
		} catch (err) {
			next(err);
		}
	});

	// DELETE /api/v1/known-agents/:name — forget an agent (its platforms stop being offered while offline)
	router.delete('/known-agents/:name', async (req, res, next) => {
		try {
			const removed = await knownAgents.remove(req.params.name);
			if (!removed) {
				res.status(404).json({ error: 'Not found', message: 'Unknown agent' });
				return;
			}
			auditLog?.append({ actor: AuditLog.actorOf(req), action: 'agent.forget', target: req.params.name });
			res.json({ success: true });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
