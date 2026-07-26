import { Router } from 'express';
import { AgentRegistry } from '../services/agent-registry.js';
import { AuditLog } from '../auth/audit-log.js';

export function createAgentRoutes(registry: AgentRegistry, auditLog: AuditLog): Router {
	const router = Router();

	// GET /api/v1/agents — list connected agents
	router.get('/agents', (_req, res) => {
		res.json({ agents: registry.list() });
	});

	// GET /api/v1/agents/:id — single agent
	router.get('/agents/:id', (req, res) => {
		const agent = registry.get(req.params.id);
		if (!agent) {
			res.status(404).json({ error: 'Not found', message: 'Agent not connected' });
			return;
		}
		res.json(agent.info);
	});

	// GET /api/v1/agents/:id/artifacts — disk used by the agent's local build artifacts.
	// Slow (walks the artifact tree); clients should render the agent list without waiting on it.
	router.get('/agents/:id/artifacts', async (req, res) => {
		if (!registry.get(req.params.id)) {
			res.status(404).json({ error: 'Not found', message: 'Agent not connected' });
			return;
		}
		try {
			res.json(await registry.requestArtifactUsage(req.params.id));
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to measure artifacts';
			res.status(502).json({ error: 'Agent request failed', message });
		}
	});

	// POST /api/v1/agents/:id/artifacts/purge — delete artifacts for all non-running builds
	router.post('/agents/:id/artifacts/purge', async (req, res) => {
		const agent = registry.get(req.params.id);
		if (!agent) {
			res.status(404).json({ error: 'Not found', message: 'Agent not connected' });
			return;
		}

		const actor = AuditLog.actorOf(req);
		// Recorded before dispatch: if the request later times out, the agent is most likely still
		// deleting, so the intent must be on record even though the outcome is unknown.
		auditLog.append({
			actor,
			action: 'agent.artifacts.purge.requested',
			target: agent.info.name,
		});

		try {
			const result = await registry.purgeArtifacts(req.params.id);
			auditLog.append({
				actor,
				action: 'agent.artifacts.purge',
				target: agent.info.name,
				details: {
					deletedCount: result.deletedCount,
					freedBytes: result.freedBytes,
					skippedBuildIds: result.skippedBuildIds,
					errorCount: result.errors.length,
				},
			});
			res.json(result);
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to purge artifacts';
			auditLog.append({
				actor,
				action: 'agent.artifacts.purge.failed',
				target: agent.info.name,
				details: { message },
			});
			res.status(502).json({ error: 'Agent request failed', message });
		}
	});

	return router;
}
