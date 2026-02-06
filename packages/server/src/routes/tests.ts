import { Router } from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import { TestResultsService } from '../services/test-results-service.js';
import { ImageComparisonService } from '../services/image-comparison-service.js';
import { TestResultsRepository } from '../repositories/test-results-repository.js';
import { ReferenceRepository } from '../repositories/reference-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import { BuildRepository } from '../repositories/build-repository.js';

export function createTestRoutes(
	testResultsService: TestResultsService,
	testResultsRepository: TestResultsRepository,
	imageComparisonService: ImageComparisonService,
	referenceRepository: ReferenceRepository,
	projectRepo: ProjectRepository,
	buildRepo: BuildRepository,
	dataPath: string
): Router {
	const router = Router();

	/**
	 * Helper to find build's project slug
	 */
	async function findProjectSlugForBuild(buildId: string): Promise<string | null> {
		const projects = await projectRepo.findAll();
		for (const project of projects) {
			const build = await buildRepo.findById(project.slug, buildId);
			if (build) return project.slug;
		}
		return null;
	}

	// GET /api/v1/builds/:buildId/tests - Get test results summary
	router.get('/builds/:buildId/tests', async (req, res, next) => {
		try {
			const { buildId } = req.params;
			const projectSlug = await findProjectSlugForBuild(buildId);

			if (!projectSlug) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}

			const results = await testResultsService.getResults(projectSlug, buildId);
			if (!results) {
				res.json({ buildId, unitTests: null, snapshotTests: null });
				return;
			}

			// Enrich snapshot results with diff percentages
			if (results.snapshotTests?.results) {
				const build = await buildRepo.findById(projectSlug, buildId);
				if (build) {
					const configurationId = build.configurationId || 'default';
					const manifest = await referenceRepository.getManifest(projectSlug, configurationId);

					await Promise.all(results.snapshotTests.results.map(async (snapshot) => {
						if (snapshot.statusText === 'crashed' || !snapshot.screenshotPath)
							return;
						if (!manifest.references[snapshot.testName])
							return;

						try {
							const screenshotPath = path.join(
								dataPath,
								testResultsRepository.getScreenshotFilePath(projectSlug, buildId, snapshot.testName)
							);
							const referencePath = referenceRepository.getReferenceImagePath(
								projectSlug, configurationId, snapshot.testName
							);

							const [screenshotStat, referenceStat] = await Promise.all([
								fs.stat(screenshotPath).catch(() => null),
								fs.stat(referencePath).catch(() => null),
							]);
							if (!screenshotStat || screenshotStat.size === 0 || !referenceStat || referenceStat.size === 0)
								return;

							snapshot.diffPercentage = await imageComparisonService.getDiffPercentage(
								screenshotPath, referencePath
							);
						} catch {
							// Comparison failed, leave diffPercentage undefined
						}
					}));
				}
			}

			res.json(results);
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/builds/:buildId/tests/unit - Get unit test results
	router.get('/builds/:buildId/tests/unit', async (req, res, next) => {
		try {
			const { buildId } = req.params;
			const projectSlug = await findProjectSlugForBuild(buildId);

			if (!projectSlug) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}

			const unitTests = await testResultsService.getUnitTests(projectSlug, buildId);
			if (!unitTests) {
				res.status(404).json({ error: 'Not found', message: 'No unit test results found' });
				return;
			}

			res.json(unitTests);
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/builds/:buildId/tests/unit/log - Get unit test console output
	router.get('/builds/:buildId/tests/unit/log', async (req, res, next) => {
		try {
			const { buildId } = req.params;
			const projectSlug = await findProjectSlugForBuild(buildId);

			if (!projectSlug) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}

			const log = await testResultsRepository.getUnitTestLog(projectSlug, buildId);
			if (log === null) {
				res.status(404).json({ error: 'Not found', message: 'Unit test log not found' });
				return;
			}

			res.json({ log });
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/builds/:buildId/tests/unit/:suiteId - Get specific test suite
	router.get('/builds/:buildId/tests/unit/:suiteId', async (req, res, next) => {
		try {
			const { buildId, suiteId } = req.params;
			const projectSlug = await findProjectSlugForBuild(buildId);

			if (!projectSlug) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}

			const suite = await testResultsService.getTestSuite(projectSlug, buildId, suiteId);
			if (!suite) {
				res.status(404).json({ error: 'Not found', message: 'Test suite not found' });
				return;
			}

			res.json(suite);
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/builds/:buildId/tests/snapshots - Get all snapshot results
	router.get('/builds/:buildId/tests/snapshots', async (req, res, next) => {
		try {
			const { buildId } = req.params;
			const projectSlug = await findProjectSlugForBuild(buildId);

			if (!projectSlug) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}

			const snapshots = await testResultsService.getSnapshotResults(projectSlug, buildId);
			res.json({ snapshots });
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/builds/:buildId/tests/snapshots/:testName - Get specific snapshot result
	router.get('/builds/:buildId/tests/snapshots/:testName', async (req, res, next) => {
		try {
			const { buildId, testName } = req.params;
			const projectSlug = await findProjectSlugForBuild(buildId);

			if (!projectSlug) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}

			const snapshot = await testResultsService.getSnapshotResult(projectSlug, buildId, testName);
			if (!snapshot) {
				res.status(404).json({ error: 'Not found', message: 'Snapshot test not found' });
				return;
			}

			res.json(snapshot);
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/builds/:buildId/tests/snapshots/:testName/screenshot - Get screenshot image
	router.get('/builds/:buildId/tests/snapshots/:testName/screenshot', async (req, res, next) => {
		try {
			const { buildId, testName } = req.params;
			const projectSlug = await findProjectSlugForBuild(buildId);

			if (!projectSlug) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}

			const screenshotPath = path.join(
				dataPath,
				testResultsRepository.getScreenshotFilePath(projectSlug, buildId, testName)
			);

			try {
				await fs.access(screenshotPath);
				res.sendFile(screenshotPath);
			} catch {
				res.status(404).json({ error: 'Not found', message: 'Screenshot not found' });
			}
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/builds/:buildId/tests/snapshots/:testName/log - Get snapshot log
	router.get('/builds/:buildId/tests/snapshots/:testName/log', async (req, res, next) => {
		try {
			const { buildId, testName } = req.params;
			const projectSlug = await findProjectSlugForBuild(buildId);

			if (!projectSlug) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}

			const log = await testResultsService.getSnapshotLog(projectSlug, buildId, testName);
			if (log === null) {
				res.status(404).json({ error: 'Not found', message: 'Log not found' });
				return;
			}

			res.json({ log });
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/builds/:buildId/tests/snapshots/:testName/compare - Compare with reference
	router.get('/builds/:buildId/tests/snapshots/:testName/compare', async (req, res, next) => {
		try {
			const { buildId, testName } = req.params;
			const projectSlug = await findProjectSlugForBuild(buildId);

			if (!projectSlug) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}

			// Get build to find configuration
			const build = await buildRepo.findById(projectSlug, buildId);
			if (!build) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}

			const configurationId = build.configurationId || 'default';

			// Check if reference exists
			const hasReference = await referenceRepository.hasReference(projectSlug, configurationId, testName);
			if (!hasReference) {
				res.json({
					hasReference: false,
					message: 'No reference image set for this test',
				});
				return;
			}

			// Get paths
			const screenshotPath = path.join(
				dataPath,
				testResultsRepository.getScreenshotFilePath(projectSlug, buildId, testName)
			);
			const referencePath = referenceRepository.getReferenceImagePath(projectSlug, configurationId, testName);
			const diffPath = path.join(
				dataPath,
				testResultsRepository.getDiffFilePath(projectSlug, buildId, testName)
			);

			// Compare images
			const result = await imageComparisonService.compareImages(screenshotPath, referencePath, diffPath);

			res.json({
				hasReference: true,
				...result,
			});
		} catch (error) {
			next(error);
		}
	});

	// GET /api/v1/builds/:buildId/tests/snapshots/:testName/diff - Get diff image
	router.get('/builds/:buildId/tests/snapshots/:testName/diff', async (req, res, next) => {
		try {
			const { buildId, testName } = req.params;
			const projectSlug = await findProjectSlugForBuild(buildId);

			if (!projectSlug) {
				res.status(404).json({ error: 'Not found', message: 'Build not found' });
				return;
			}

			const diffPath = path.join(
				dataPath,
				testResultsRepository.getDiffFilePath(projectSlug, buildId, testName)
			);

			try {
				await fs.access(diffPath);
				res.sendFile(diffPath);
			} catch {
				res.status(404).json({ error: 'Not found', message: 'Diff image not found. Run comparison first.' });
			}
		} catch (error) {
			next(error);
		}
	});

	return router;
}
