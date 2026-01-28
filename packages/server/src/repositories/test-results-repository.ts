import type { BuildTestResults, UnitTestOutput, AggregatedSnapshotResult, TestSuite } from '@banshee-forge/shared';
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
 *     ├── {testName}/
 *     │   ├── result.json   # SnapshotTestResult
 *     │   ├── screenshot.png
 *     │   └── log.txt
 *     └── ...
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

	private snapshotPath(projectSlug: string, buildId: string, testName: string): string {
		return `${this.basePath(projectSlug, buildId)}/snapshots/${testName}`;
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
		testName: string,
		result: AggregatedSnapshotResult
	): Promise<void> {
		const resultPath = `${this.snapshotPath(projectSlug, buildId, testName)}/result.json`;
		await this.storage.write(resultPath, result);
	}

	/**
	 * Get snapshot test result
	 */
	async getSnapshotResult(
		projectSlug: string,
		buildId: string,
		testName: string
	): Promise<AggregatedSnapshotResult | null> {
		const resultPath = `${this.snapshotPath(projectSlug, buildId, testName)}/result.json`;
		const exists = await this.storage.exists(resultPath);
		if (!exists) return null;
		return this.storage.read<AggregatedSnapshotResult>(resultPath, null as any);
	}

	/**
	 * Get all snapshot results for a build
	 */
	async getAllSnapshotResults(projectSlug: string, buildId: string): Promise<AggregatedSnapshotResult[]> {
		const results = await this.getResults(projectSlug, buildId);
		return results?.snapshotTests?.results ?? [];
	}

	/**
	 * Get the filesystem path to a snapshot screenshot
	 */
	getScreenshotFilePath(projectSlug: string, buildId: string, testName: string): string {
		return path.join(this.basePath(projectSlug, buildId), 'snapshots', testName, 'screenshot.png');
	}

	/**
	 * Get the filesystem path to a snapshot diff image
	 */
	getDiffFilePath(projectSlug: string, buildId: string, testName: string): string {
		return path.join(this.basePath(projectSlug, buildId), 'snapshots', testName, 'diff.png');
	}

	/**
	 * Get the filesystem path to a snapshot log file
	 */
	getLogFilePath(projectSlug: string, buildId: string, testName: string): string {
		return path.join(this.basePath(projectSlug, buildId), 'snapshots', testName, 'log.txt');
	}

	/**
	 * Get snapshot log content
	 */
	async getSnapshotLog(projectSlug: string, buildId: string, testName: string): Promise<string | null> {
		const logPath = `${this.snapshotPath(projectSlug, buildId, testName)}/log.txt`;
		return this.storage.readText(logPath);
	}

	/**
	 * Check if test results exist for a build
	 */
	async hasResults(projectSlug: string, buildId: string): Promise<boolean> {
		return this.storage.exists(this.resultsPath(projectSlug, buildId));
	}
}
