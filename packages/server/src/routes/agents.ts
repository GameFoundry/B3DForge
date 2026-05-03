import { Router } from 'express';
import { AgentRegistry } from '../services/agent-registry.js';

export function createAgentRoutes(registry: AgentRegistry): Router {
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

	return router;
}
