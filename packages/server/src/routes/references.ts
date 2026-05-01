import { Router } from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import { ReferenceRepository } from '../repositories/reference-repository.js';
import { TestResultsRepository } from '../repositories/test-results-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import { BuildRepository } from '../repositories/build-repository.js';
import { AuditLog } from '../auth/audit-log.js';

export function createReferenceRoutes(
	referenceRepository: ReferenceRepository,
	testResultsRepository: TestResultsRepository,
	projectRepo: ProjectRepository,
	buildRepo: BuildRepository,
	dataPath: string,
	auditLog?: AuditLog
): Router {
	const router = Router();

	// GET /api/v1/projects/:slug/references - List all references for a project
	router.get('/projects/:slug/references', async (req, res, next) => {
		try {
			const { slug } = req.params;
			const project = await projectRepo.findBySlug(slug);

			if (!project) {
				res.status(404).json({ error: 'Not found', message: 'Project not found' });
				return;
			}

			const references = await referenceRepository.listReferences(slug);
			res.json({ references });
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/projects/:slug/references/:configId - List references for a configuration
	router.get('/projects/:slug/references/:configId', async (req, res, next) => {
		try {
			const { slug, configId } = req.params;
			const project = await projectRepo.findBySlug(slug);

			if (!project) {
				res.status(404).json({ error: 'Not found', message: 'Project not found' });
				return;
			}

			const references = await referenceRepository.listConfigurationReferences(slug, configId);
			res.json({ references });
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/projects/:slug/references/:configId/:testName - Get reference image
	router.get('/projects/:slug/references/:configId/:testName', async (req, res, next) => {
		try {
			const { slug, configId, testName } = req.params;

			const hasReference = await referenceRepository.hasReference(slug, configId, testName);
			if (!hasReference) {
				res.status(404).json({ error: 'Not found', message: 'Reference image not found' });
				return;
			}

			const imagePath = referenceRepository.getReferenceImagePath(slug, configId, testName);
			res.sendFile(imagePath);
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/projects/:slug/references/:configId/:testName/info - Get reference info
	router.get('/projects/:slug/references/:configId/:testName/info', async (req, res, next) => {
		try {
			const { slug, configId, testName } = req.params;

			const info = await referenceRepository.getReferenceInfo(slug, configId, testName);
			if (!info) {
				res.status(404).json({ error: 'Not found', message: 'Reference not found' });
				return;
			}

			res.json(info);
		} catch (error) {
			next(error);
		}
	});

	// PUT /api/v1/projects/:slug/references/:configId/:testName - Set reference from build screenshot
	router.put('/projects/:slug/references/:configId/:testName', async (req, res, next) => {
		try {
			const { slug, configId, testName } = req.params;
			const { buildId } = req.body;

			if (!buildId) {
				res.status(400).json({ error: 'Bad request', message: 'buildId is required' });
				return;
			}

			const project = await projectRepo.findBySlug(slug);
			if (!project) {
				res.status(404).json({ error: 'Not found', message: 'Project not found' });
				return;
			}

			// Verify build exists
			const build = await buildRepo.findById(slug, buildId);
			if (!build) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}

			// Get screenshot path
			const screenshotPath = path.join(
				dataPath,
				testResultsRepository.getScreenshotFilePath(slug, buildId, testName)
			);

			// Verify screenshot exists
			try {
				await fs.access(screenshotPath);
			} catch {
				res.status(404).json({ error: 'Not found', message: 'Screenshot not found for this test' });
				return;
			}

			// Set as reference
			const info = await referenceRepository.setReference(slug, configId, testName, screenshotPath, buildId);
			auditLog?.append({ actor: AuditLog.actorOf(req), action: 'reference.set', target: `${slug}/${configId}/${testName}`, details: { buildId } });
			res.json(info);
		} catch (error) {
			next(error);
		}
	});

	// DELETE /api/v1/projects/:slug/references/:configId/:testName - Delete reference
	router.delete('/projects/:slug/references/:configId/:testName', async (req, res, next) => {
		try {
			const { slug, configId, testName } = req.params;

			const deleted = await referenceRepository.deleteReference(slug, configId, testName);
			if (!deleted) {
				res.status(404).json({ error: 'Not found', message: 'Reference not found' });
				return;
			}

			auditLog?.append({ actor: AuditLog.actorOf(req), action: 'reference.delete', target: `${slug}/${configId}/${testName}` });
			res.json({ success: true });
		} catch (error) {
			next(error);
		}
	});

	// POST /api/v1/projects/:slug/references/:configId/copy - Copy references from another config
	router.post('/projects/:slug/references/:configId/copy', async (req, res, next) => {
		try {
			const { slug, configId } = req.params;
			const { sourceConfigId } = req.body;

			if (!sourceConfigId) {
				res.status(400).json({ error: 'Bad request', message: 'sourceConfigId is required' });
				return;
			}

			const project = await projectRepo.findBySlug(slug);
			if (!project) {
				res.status(404).json({ error: 'Not found', message: 'Project not found' });
				return;
			}

			const count = await referenceRepository.copyReferences(slug, sourceConfigId, configId);
			auditLog?.append({ actor: AuditLog.actorOf(req), action: 'reference.copy', target: `${slug}/${configId}`, details: { sourceConfigId, copiedCount: count } });
			res.json({ success: true, copiedCount: count });
		} catch (error) {
			next(error);
		}
	});

	return router;
}
