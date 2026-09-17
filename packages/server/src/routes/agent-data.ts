import { Router, type RequestHandler } from 'express';
import express from 'express';
import { createHash } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import type { Deployment } from '@banshee-forge/shared';
import { DeploymentRepository } from '../repositories/deployment-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import { DeploymentService, DeploymentError } from '../services/deployment-service.js';

export interface AgentDataDeps {
	dataPath: string;
	/** Largest single file an agent may upload for a deployment, in bytes. */
	maxDeploymentUploadBytes: number;
	deploymentRepo: DeploymentRepository;
	projectRepo: ProjectRepository;
	deploymentService: DeploymentService;
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

	// POST /agent/deployments/:deploymentId/files
	// Headers: X-Relative-Path (a path the build recorded in its deploy directory),
	//          X-Content-Sha256 (hex digest the agent computed), Content-Length.
	// Body:    raw bytes, streamed to disk. Deployment archives run to gigabytes, so the body is
	//          never buffered; it is hashed on the way to a temporary file that only becomes the
	//          final one once the digest matched.
	router.post('/deployments/:deploymentId/files', requireAgent, async (req, res) => {
		const relPath = (req.header('X-Relative-Path') ?? '').trim();
		const expectedSha = (req.header('X-Content-Sha256') ?? '').trim().toLowerCase();
		const declaredLength = Number(req.header('Content-Length') ?? '');

		if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
			res.status(400).json({ error: 'X-Content-Sha256 must be a hex SHA-256 digest' });
			return;
		}
		if (!Number.isFinite(declaredLength) || declaredLength <= 0) {
			res.status(411).json({ error: 'Content-Length required' });
			return;
		}
		if (declaredLength > deps.maxDeploymentUploadBytes) {
			res.status(413).json({ error: `file exceeds the ${deps.maxDeploymentUploadBytes} byte upload limit` });
			return;
		}

		let found: { deployment: Deployment; targetPath: string } | null = null;
		try {
			for (const project of await deps.projectRepo.findAll()) {
				const deployment = await deps.deploymentRepo.findById(project.slug, req.params.deploymentId);
				if (!deployment) continue;
				const targetPath = await deps.deploymentService.authorizeUpload(deployment, req.agent!.id, relPath);
				found = { deployment, targetPath };
				break;
			}
		} catch (err) {
			if (err instanceof DeploymentError) {
				res.status(403).json({ error: err.message });
				return;
			}
			throw err;
		}
		if (!found) {
			res.status(404).json({ error: 'deployment not found' });
			return;
		}

		const tempPath = `${found.targetPath}.${process.pid}.${Date.now()}.part`;
		const hash = createHash('sha256');
		let received = 0;
		const hashing = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				received += chunk.length;
				if (received > deps.maxDeploymentUploadBytes) {
					callback(new Error('upload limit exceeded'));
					return;
				}
				hash.update(chunk);
				callback(null, chunk);
			},
		});

		try {
			await pipeline(req, hashing, createWriteStream(tempPath));
			const actualSha = hash.digest('hex');
			if (received !== declaredLength || actualSha !== expectedSha) {
				await fs.rm(tempPath, { force: true });
				res.status(422).json({ error: received !== declaredLength ? 'incomplete upload' : 'checksum mismatch' });
				return;
			}
			await fs.rename(tempPath, found.targetPath);
			// Sidecar with the accepted digest lets the deployment verify the file later without rehashing it.
			await fs.writeFile(`${found.targetPath}.sha256`, actualSha, 'utf-8');
			await deps.deploymentService.onFileReceived(found.deployment, relPath.replace(/\\/g, '/'), received);
			res.status(204).end();
		} catch (err) {
			await fs.rm(tempPath, { force: true }).catch(() => undefined);
			console.error(`Failed to receive deployment upload ${relPath} for ${req.params.deploymentId}:`, err);
			if (!res.headersSent) res.status(500).json({ error: 'upload failed' });
		}
	});

	return router;
}
