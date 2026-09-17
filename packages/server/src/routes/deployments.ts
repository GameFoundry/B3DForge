import { Router } from 'express';
import path from 'path';
import type { CreateDeploymentInput, Deployment, Project } from '@banshee-forge/shared';
import { parseLog } from '@banshee-forge/shared';
import { BuildRepository } from '../repositories/build-repository.js';
import { DeploymentRepository } from '../repositories/deployment-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import { DeploymentService, DeploymentError } from '../services/deployment-service.js';
import { AuditLog } from '../auth/audit-log.js';

/**
 * User-facing deployment endpoints: eligibility, start, status, logs, retry, cancel and artifact
 * download. Mounted under `/api/v1` behind user authentication.
 */
export function createDeploymentRoutes(
	deploymentRepo: DeploymentRepository,
	buildRepo: BuildRepository,
	projectRepo: ProjectRepository,
	deploymentService: DeploymentService,
	auditLog?: AuditLog,
): Router {
	const router = Router();

	/** Locate a build by id across projects. */
	async function findBuild(buildId: string) {
		for (const project of await projectRepo.findAll()) {
			const build = await buildRepo.findById(project.slug, buildId);
			if (build) return { build, project };
		}
		return null;
	}

	/** Locate a deployment by id across projects. */
	async function findDeployment(deploymentId: string): Promise<{ deployment: Deployment; project: Project } | null> {
		for (const project of await projectRepo.findAll()) {
			const deployment = await deploymentRepo.findById(project.slug, deploymentId);
			if (deployment) return { deployment, project };
		}
		return null;
	}

	// GET /api/v1/builds/:id/deploy-eligibility
	router.get('/builds/:id/deploy-eligibility', async (req, res, next) => {
		try {
			const found = await findBuild(req.params.id);
			if (!found) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}
			res.json(await deploymentService.checkEligibility(found.build, found.project));
		} catch (error) {
			next(error);
		}
	});

	// POST /api/v1/builds/:id/deployments - Deploy a successful build
	router.post('/builds/:id/deployments', async (req, res, next) => {
		try {
			const found = await findBuild(req.params.id);
			if (!found) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}
			const input = (req.body ?? {}) as CreateDeploymentInput;
			const deployment = await deploymentService.createDeployment(found.build, found.project, input, 'manual', req.user?.username, 'build');
			auditLog?.append({ actor: AuditLog.actorOf(req), action: 'deployment.start', target: `${found.project.slug}/${deployment.id}`, details: { buildId: found.build.id, platform: found.build.platform, targetBranch: deployment.targetBranch ?? null, parameters: deployment.parameters } });
			res.status(201).json(deployment);
		} catch (error) {
			if (error instanceof DeploymentError) {
				res.status(400).json({ error: 'Bad request', message: error.message });
				return;
			}
			next(error);
		}
	});

	// GET /api/v1/builds/:id/deployments - Deployments of a build, newest first
	router.get('/builds/:id/deployments', async (req, res, next) => {
		try {
			const found = await findBuild(req.params.id);
			if (!found) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}
			const deployments = await deploymentRepo.listForBuild(found.project.slug, found.build.id);
			res.json({ deployments: deployments.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/projects/:slug/deployments - Deployment index of a project
	router.get('/projects/:slug/deployments', async (req, res, next) => {
		try {
			const project = await projectRepo.findBySlug(req.params.slug);
			if (!project) {
				res.status(404).json({ error: 'Not found', message: 'Project not found' });
				return;
			}
			res.json({ deployments: await deploymentRepo.list(project.slug) });
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/deployments/:id
	router.get('/deployments/:id', async (req, res, next) => {
		try {
			const found = await findDeployment(req.params.id);
			if (!found) {
				res.status(404).json({ error: 'Not found', message: 'Deployment not found' });
				return;
			}
			res.json(found.deployment);
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/deployments/:id/log[?format=text]
	router.get('/deployments/:id/log', async (req, res, next) => {
		try {
			const found = await findDeployment(req.params.id);
			if (!found) {
				res.status(404).json({ error: 'Not found', message: 'Deployment not found' });
				return;
			}
			const log = (await deploymentRepo.getLog(found.project.slug, found.deployment.id)) ?? '';
			if (req.query.format === 'text') {
				res.type('text/plain').send(log);
				return;
			}
			const { lines } = parseLog(log);
			res.json({ lines, totalLines: lines.length });
		} catch (error) {
			next(error);
		}
	});

	// POST /api/v1/deployments/:id/retry
	router.post('/deployments/:id/retry', async (req, res, next) => {
		try {
			const found = await findDeployment(req.params.id);
			if (!found) {
				res.status(404).json({ error: 'Not found', message: 'Deployment not found' });
				return;
			}
			const deployment = await deploymentService.retry(found.deployment, req.user?.username);
			auditLog?.append({ actor: AuditLog.actorOf(req), action: 'deployment.retry', target: `${found.project.slug}/${deployment.id}`, details: { previous: found.deployment.id } });
			res.status(201).json(deployment);
		} catch (error) {
			if (error instanceof DeploymentError) {
				res.status(400).json({ error: 'Bad request', message: error.message });
				return;
			}
			next(error);
		}
	});

	// POST /api/v1/deployments/:id/cancel
	router.post('/deployments/:id/cancel', async (req, res, next) => {
		try {
			const found = await findDeployment(req.params.id);
			if (!found) {
				res.status(404).json({ error: 'Not found', message: 'Deployment not found' });
				return;
			}
			const cancelled = await deploymentService.cancel(found.deployment);
			if (!cancelled) {
				res.status(400).json({ error: 'Bad request', message: 'Deployment cannot be cancelled' });
				return;
			}
			auditLog?.append({ actor: AuditLog.actorOf(req), action: 'deployment.cancel', target: `${found.project.slug}/${found.deployment.id}` });
			res.json({ success: true });
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/deployments/:id/artifacts/<path> - Download a file deploy.sh left in its output directory
	router.get('/deployments/:id/artifacts/*', async (req, res, next) => {
		try {
			const found = await findDeployment(req.params.id);
			if (!found) {
				res.status(404).json({ error: 'Not found', message: 'Deployment not found' });
				return;
			}
			const requested = String((req.params as Record<string, string>)[0] ?? '').replace(/\\/g, '/');
			const artifact = found.deployment.artifacts.find(a => a.path === requested);
			if (!artifact) {
				res.status(404).json({ error: 'Not found', message: 'Artifact not found' });
				return;
			}
			const outputRoot = deploymentRepo.outputDirectory(found.project.slug, found.deployment.id);
			const filePath = path.resolve(outputRoot, artifact.path);
			if (!filePath.startsWith(outputRoot + path.sep)) {
				res.status(400).json({ error: 'Bad request', message: 'Invalid artifact path' });
				return;
			}
			res.download(filePath, path.basename(artifact.path));
		} catch (error) {
			next(error);
		}
	});

	return router;
}
