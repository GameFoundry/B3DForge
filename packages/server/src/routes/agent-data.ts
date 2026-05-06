import { Router, type RequestHandler } from 'express';
import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';

export interface AgentDataDeps {
	dataPath: string;
}

/**
 * Routes mounted at `/api/v1/agent`, used by build agents to upload artifacts
 * to the orchestrator. Bearer-token authenticated via the `requireAgent` middleware
 * supplied by the caller.
 */
export function createAgentDataRoutes(deps: AgentDataDeps, requireAgent: RequestHandler): Router {
	const router = Router();

	// POST /agent/projects/:projectSlug/builds/:buildId/result-file
	// Header: X-Relative-Path  e.g. "snapshots/Lighting/result.json"
	// Body:   raw bytes (application/octet-stream)
	router.post(
		'/projects/:projectSlug/builds/:buildId/result-file',
		requireAgent,
		express.raw({ type: 'application/octet-stream', limit: '100mb' }),
		async (req, res) => {
			const { projectSlug, buildId } = req.params;
			const relPath = (req.header('X-Relative-Path') ?? '').trim();

			if (!relPath || relPath.includes('..') || path.isAbsolute(relPath) || relPath.includes('\0')) {
				res.status(400).json({ error: 'invalid X-Relative-Path' });
				return;
			}

			const resultsRoot = path.resolve(
				deps.dataPath, 'projects', projectSlug, 'builds', buildId, 'results',
			);
			const targetPath = path.resolve(resultsRoot, relPath);
			if (targetPath !== resultsRoot && !targetPath.startsWith(resultsRoot + path.sep)) {
				res.status(400).json({ error: 'path traversal blocked' });
				return;
			}

			try {
				await fs.mkdir(path.dirname(targetPath), { recursive: true });
				await fs.writeFile(targetPath, req.body as Buffer);
				res.status(204).end();
			} catch (err) {
				console.error(`Failed to write agent upload ${relPath} for build ${buildId}:`, err);
				res.status(500).json({ error: 'write failed' });
			}
		},
	);

	return router;
}
