import { promises as fs } from 'fs';
import type { AggregatedSnapshotResult } from '@banshee-forge/shared';
import { DEFAULT_SNAPSHOT_CATEGORY } from '@banshee-forge/shared';
import { TestResultsRepository } from '../repositories/test-results-repository.js';
import { ReferenceRepository } from '../repositories/reference-repository.js';
import { ImageComparisonService } from './image-comparison-service.js';

export interface SnapshotDiffContext {
	testResultsRepo: TestResultsRepository;
	referenceRepo: ReferenceRepository;
	imageComparison: ImageComparisonService;
	projectSlug: string;
	buildId: string;
	configurationId: string;
	platform: string;
}

/**
 * Percentage of pixels that differ between a snapshot's screenshot and the reference image of its
 * configuration and platform. Undefined when the test crashed, has no reference, either image is
 * missing or empty, or the comparison fails. The caller checks the reference manifest first.
 */
export async function computeSnapshotDiffPercentage(
	context: SnapshotDiffContext,
	snapshot: AggregatedSnapshotResult,
): Promise<number | undefined> {
	if (snapshot.statusText === 'crashed' || !snapshot.screenshotPath)
		return undefined;

	const category = snapshot.category ?? DEFAULT_SNAPSHOT_CATEGORY;
	try {
		const screenshotPath = await context.testResultsRepo.resolveSnapshotFilePath(
			context.projectSlug, context.buildId, category, snapshot.testName, 'screenshot.png'
		);
		if (!screenshotPath) return undefined;

		const referencePath = context.referenceRepo.getReferenceImagePath(
			context.projectSlug, context.configurationId, context.platform, category, snapshot.testName
		);

		const [screenshotStat, referenceStat] = await Promise.all([
			fs.stat(screenshotPath).catch(() => null),
			fs.stat(referencePath).catch(() => null),
		]);
		if (!screenshotStat || screenshotStat.size === 0 || !referenceStat || referenceStat.size === 0)
			return undefined;

		return await context.imageComparison.getDiffPercentage(screenshotPath, referencePath);
	} catch {
		return undefined;
	}
}
