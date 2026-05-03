import { Router } from 'express';
import { AgentTokensRepository } from '../auth/agent-tokens-repository.js';
import { AuditLog } from '../auth/audit-log.js';

export function createAgentTokenRoutes(repo: AgentTokensRepository, auditLog?: AuditLog): Router {
	const router = Router();

	router.get('/', async (_req, res, next) => {
		try {
			res.json({ tokens: await repo.list() });
		} catch (err) {
			next(err);
		}
	});

	router.post('/', async (req, res, next) => {
		try {
			const name = (req.body?.name ?? '').toString().trim();
			if (!name) {
				res.status(400).json({ error: 'Bad request', message: 'name is required' });
				return;
			}
			const created = await repo.create(name);
			auditLog?.append({
				actor: AuditLog.actorOf(req),
				action: 'agent-token.create',
				target: created.record.id,
				details: { name },
			});
			res.status(201).json({ ...created.record, plaintext: created.plaintext });
		} catch (err) {
			next(err);
		}
	});

	router.delete('/:id', async (req, res, next) => {
		try {
			const ok = await repo.revoke(req.params.id);
			if (!ok) {
				res.status(404).json({ error: 'Not found', message: 'Token not found' });
				return;
			}
			auditLog?.append({
				actor: AuditLog.actorOf(req),
				action: 'agent-token.revoke',
				target: req.params.id,
			});
			res.status(204).end();
		} catch (err) {
			next(err);
		}
	});

	return router;
}
