import type { BuildTestResults, UnitTestOutput, AggregatedSnapshotResult, TestSuite } from '@banshee-forge/shared';
import { DEFAULT_SNAPSHOT_CATEGORY } from '@banshee-forge/shared';
import { JsonFileStorage } from '../storage/json-file.js';
import path from 'path';

/**
 * Repository for test results storage and retrieval.
 *
 * Storage structure:
 * data/projects/{slug}/builds/{buildId}/tests/
 * ├── results.json          # Aggregated BuildTestResults
 * ├── unit/
 * │   └── raw-output.json   # Original UnitTestRunner output
 * └── snapshots/
 *     ├── {category}/
 *     │   ├── {testName}/
 *     │   │   ├── result.json   # SnapshotTestResult
 *     │   │   ├── screenshot.png
 *     │   │   └── log.txt
 *     │   └── ...
 *     └── ...
 *
 * Builds stored before categories existed use a flat snapshots/{testName}/ layout;
 * reads fall back to it when the requested category is DEFAULT_SNAPSHOT_CATEGORY.
 */
export class TestResultsRepository {
	constructor(private storage: JsonFileStorage) {}

	private basePath(projectSlug: string, buildId: string): string {
		return `projects/${projectSlug}/builds/${buildId}/tests`;
	}

	private resultsPath(projectSlug: string, buildId: string): string {
		return `${this.basePath(projectSlug, buildId)}/results.json`;
	}

	private unitTestPath(projectSlug: string, buildId: string): string {
		return `${this.basePath(projectSlug, buildId)}/unit/raw-output.json`;
	}

	private snapshotPath(projectSlug: string, buildId: string, category: string, testName: string): string {
		return `${this.basePath(projectSlug, buildId)}/snapshots/${category}/${testName}`;
	}

	private legacySnapshotPath(projectSlug: string, buildId: string, testName: string): string {
		return `${this.basePath(projectSlug, buildId)}/snapshots/${testName}`;
	}

	/**
	 * Resolve the storage-relative directory holding a snapshot test's files, falling
	 * back to the legacy flat layout (no category level) for builds stored before
	 * categories existed. Returns null if the test exists in neither location.
	 */
	async resolveSnapshotDir(
		projectSlug: string,
		buildId: string,
		category: string,
		testName: string
	): Promise<string | null> {
		const categorized = this.snapshotPath(projectSlug, buildId, category, testName);
		if (await this.storage.exists(`${categorized}/result.json`)) return categorized;

		if (category === DEFAULT_SNAPSHOT_CATEGORY) {
			const legacy = this.legacySnapshotPath(projectSlug, buildId, testName);
			if (await this.storage.exists(`${legacy}/result.json`)) return legacy;
		}

		return null;
	}

	/**
	 * Resolve the absolute filesystem path of a snapshot file (screenshot.png, diff.png,
	 * log.txt, ...), honoring the legacy layout. Returns null if the test dir doesn't exist.
	 */
	async resolveSnapshotFilePath(
		projectSlug: string,
		buildId: string,
		category: string,
		testName: string,
		fileName: string
	): Promise<string | null> {
		const dir = await this.resolveSnapshotDir(projectSlug, buildId, category, testName);
		if (!dir) return null;
		return path.join(this.storage.getBasePath(), dir, fileName);
	}

	/**
	 * Absolute directory snapshot files are written to during parsing (always the
	 * categorized layout).
	 */
	getSnapshotAbsoluteDir(projectSlug: string, buildId: string, category: string, testName: string): string {
		return path.join(this.storage.getBasePath(), this.snapshotPath(projectSlug, buildId, category, testName));
	}

	/**
	 * Absolute directory unit test files are written to during parsing.
	 */
	getUnitTestAbsoluteDir(projectSlug: string, buildId: string): string {
		return path.join(this.storage.getBasePath(), this.basePath(projectSlug, buildId), 'unit');
	}

	/**
	 * Save aggregated test results for a build
	 */
	async saveResults(projectSlug: string, buildId: string, results: BuildTestResults): Promise<void> {
		await this.storage.write(this.resultsPath(projectSlug, buildId), results);
	}

	/**
	 * Get aggregated test results for a build
	 */
	async getResults(projectSlug: string, buildId: string): Promise<BuildTestResults | null> {
		const exists = await this.storage.exists(this.resultsPath(projectSlug, buildId));
		if (!exists) return null;
		return this.storage.read<BuildTestResults>(this.resultsPath(projectSlug, buildId), null as any);
	}

	/**
	 * Save raw unit test output
	 */
	async saveUnitTestOutput(projectSlug: string, buildId: string, output: UnitTestOutput): Promise<void> {
		await this.storage.write(this.unitTestPath(projectSlug, buildId), output);
	}

	/**
	 * Get raw unit test output
	 */
	async getUnitTestOutput(projectSlug: string, buildId: string): Promise<UnitTestOutput | null> {
		const exists = await this.storage.exists(this.unitTestPath(projectSlug, buildId));
		if (!exists) return null;
		return this.storage.read<UnitTestOutput>(this.unitTestPath(projectSlug, buildId), null as any);
	}

	/**
	 * Get a specific test suite by name from unit test output
	 */
	async getTestSuite(projectSlug: string, buildId: string, suiteName: string): Promise<TestSuite | null> {
		const output = await this.getUnitTestOutput(projectSlug, buildId);
		if (!output) return null;
		return output.suites.find(s => s.name === suiteName) ?? null;
	}

	/**
	 * Save snapshot test result
	 */
	async saveSnapshotResult(
		projectSlug: string,
		buildId: string,
		category: string,
		testName: string,
		result: AggregatedSnapshotResult
	): Promise<void> {
		const resultPath = `${this.snapshotPath(projectSlug, buildId, category, testName)}/result.json`;
		await this.storage.write(resultPath, result);
	}

	/**
	 * Get snapshot test result
	 */
	async getSnapshotResult(
		projectSlug: string,
		buildId: string,
		category: string,
		testName: string
	): Promise<AggregatedSnapshotResult | null> {
		const dir = await this.resolveSnapshotDir(projectSlug, buildId, category, testName);
		if (!dir) return null;
		return this.storage.read<AggregatedSnapshotResult>(`${dir}/result.json`, null as any);
	}

	/**
	 * Get all snapshot results for a build
	 */
	async getAllSnapshotResults(projectSlug: string, buildId: string): Promise<AggregatedSnapshotResult[]> {
		const results = await this.getResults(projectSlug, buildId);
		return results?.snapshotTests?.results ?? [];
	}

	/**
	 * Get snapshot log content
	 */
	async getSnapshotLog(
		projectSlug: string,
		buildId: string,
		category: string,
		testName: string
	): Promise<string | null> {
		const dir = await this.resolveSnapshotDir(projectSlug, buildId, category, testName);
		if (!dir) return null;
		return this.storage.readText(`${dir}/log.txt`);
	}

	/**
	 * Check if test results exist for a build
	 */
	async hasResults(projectSlug: string, buildId: string): Promise<boolean> {
		return this.storage.exists(this.resultsPath(projectSlug, buildId));
	}

	/**
	 * Get the filesystem path to the unit test log file
	 */
	getUnitTestLogFilePath(projectSlug: string, buildId: string): string {
		return path.join(this.basePath(projectSlug, buildId), 'unit', 'log.txt');
	}

	/**
	 * Get unit test log content
	 */
	async getUnitTestLog(projectSlug: string, buildId: string): Promise<string | null> {
		const logPath = `${this.basePath(projectSlug, buildId)}/unit/log.txt`;
		return this.storage.readText(logPath);
	}
}
