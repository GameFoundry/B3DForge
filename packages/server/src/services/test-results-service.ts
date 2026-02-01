import { promises as fs } from 'fs';
import path from 'path';
import type {
	BuildTestResults,
	UnitTestOutput,
	AggregatedSnapshotResult,
	TestSummary,
	TestSuite
} from '@banshee-forge/shared';
import { TestResultsRepository } from '../repositories/test-results-repository.js';

/**
 * Service for parsing, aggregating, and managing test results.
 *
 * Handles two types of test output:
 * 1. Unit tests: JSON from UnitTestRunner with `type: "unit_test"`
 * 2. Snapshot tests: JSON per example with `type: "snapshot_test"`, plus screenshots and logs
 */
export class TestResultsService {
	constructor(private repository: TestResultsRepository) {}

	/**
	 * Parse test output files from the results directory and store aggregated results.
	 *
	 * Expected directory structure:
	 * resultsDir/
	 * ├── unit_tests.json         # or test_results.json
	 * └── snapshots/
	 *     ├── ExampleLighting/
	 *     │   ├── ExampleLighting_result.json
	 *     │   ├── ExampleLighting_screenshot.png
	 *     │   └── ExampleLighting_log.txt
	 *     └── ExamplePhysics/
	 *         └── ...
	 */
	async parseAndStoreResults(
		projectSlug: string,
		buildId: string,
		resultsDir: string
	): Promise<BuildTestResults> {
		const results: BuildTestResults = { buildId };

		// Parse unit tests
		const unitTestOutput = await this.parseUnitTests(resultsDir);
		if (unitTestOutput) {
			await this.repository.saveUnitTestOutput(projectSlug, buildId, unitTestOutput);
			results.unitTests = {
				source: 'unit_tests.json',
				summary: {
					total: unitTestOutput.summary.totalTests,
					passed: unitTestOutput.summary.passedTests,
					failed: unitTestOutput.summary.failedTests,
				},
				suites: unitTestOutput.suites,
			};

			// Copy unit test log file if it exists
			await this.copyUnitTestLog(resultsDir, projectSlug, buildId);
		}

		// Parse snapshot tests
		const snapshotResults = await this.parseSnapshotTests(resultsDir, projectSlug, buildId);
		if (snapshotResults.length > 0) {
			const passed = snapshotResults.filter(r => r.statusText === 'passed').length;
			const failed = snapshotResults.filter(r => r.statusText === 'failed').length;

			results.snapshotTests = {
				results: snapshotResults,
				summary: {
					total: snapshotResults.length,
					passed,
					failed,
				},
			};

			// Save individual snapshot results
			for (const result of snapshotResults) {
				await this.repository.saveSnapshotResult(projectSlug, buildId, result.testName, result);
			}
		}

		// Save aggregated results
		await this.repository.saveResults(projectSlug, buildId, results);

		return results;
	}

	/**
	 * Copy unit test log file to storage location
	 */
	private async copyUnitTestLog(
		resultsDir: string,
		projectSlug: string,
		buildId: string
	): Promise<void> {
		const destDir = path.join(
			this.repository['storage']['basePath'],
			this.repository['basePath'](projectSlug, buildId),
			'unit'
		);

		await fs.mkdir(destDir, { recursive: true });

		// Try different log file locations (unit_tests.log matches unit_tests.json)
		const logCandidates = [
			path.join(resultsDir, 'unit_tests.log'),
			path.join(resultsDir, 'unit_test_log.txt'),
		];

		for (const sourcePath of logCandidates) {
			try {
				await fs.access(sourcePath);
				await fs.copyFile(sourcePath, path.join(destDir, 'log.txt'));
				return;
			} catch {
				// Try next candidate
			}
		}
	}

	/**
	 * Parse unit test JSON files from the results directory
	 */
	private async parseUnitTests(resultsDir: string): Promise<UnitTestOutput | null> {
		// Try common filenames
		const candidates = ['unit_tests.json', 'test_results.json', 'results.json'];

		for (const filename of candidates) {
			const filePath = path.join(resultsDir, filename);
			try {
				let content = await fs.readFile(filePath, 'utf-8');
				// Strip UTF-8 BOM if present
				if (content.charCodeAt(0) === 0xFEFF) {
					content = content.slice(1);
				}
				const parsed = JSON.parse(content);

				// Validate it's a unit test output
				if (parsed.type === 'unit_test' && Array.isArray(parsed.suites)) {
					return parsed as UnitTestOutput;
				}
			} catch {
				// File doesn't exist or isn't valid JSON, try next
			}
		}

		return null;
	}

	/**
	 * Parse snapshot test results from the results directory
	 */
	private async parseSnapshotTests(
		resultsDir: string,
		projectSlug: string,
		buildId: string
	): Promise<AggregatedSnapshotResult[]> {
		const snapshotsDir = path.join(resultsDir, 'snapshots');
		const results: AggregatedSnapshotResult[] = [];

		try {
			const entries = await fs.readdir(snapshotsDir, { withFileTypes: true });

			for (const entry of entries) {
				if (!entry.isDirectory()) continue;

				const testName = entry.name;
				const testDir = path.join(snapshotsDir, testName);

				// Find result.json file (may be named {testName}_result.json or result.json)
				const result = await this.parseSnapshotResult(testDir, testName);
				if (result) {
					// Copy files to storage and update paths
					await this.copySnapshotFiles(testDir, projectSlug, buildId, testName, result);
					results.push(result);
				}
			}
		} catch {
			// Snapshots directory doesn't exist, that's fine
		}

		return results;
	}

	/**
	 * Parse a single snapshot test result JSON
	 */
	private async parseSnapshotResult(testDir: string, testName: string): Promise<AggregatedSnapshotResult | null> {
		// Try different naming conventions
		const candidates = [
			`${testName}_result.json`,
			'result.json',
			`${testName}.json`,
		];

		for (const filename of candidates) {
			const filePath = path.join(testDir, filename);
			try {
				let content = await fs.readFile(filePath, 'utf-8');
				// Strip UTF-8 BOM if present
				if (content.charCodeAt(0) === 0xFEFF) {
					content = content.slice(1);
				}
				const parsed = JSON.parse(content);

				// Validate it's a snapshot test result
				if (parsed.type === 'snapshot_test') {
					return parsed as AggregatedSnapshotResult;
				}
			} catch {
				// File doesn't exist or isn't valid JSON, try next
			}
		}

		return null;
	}

	/**
	 * Copy snapshot files (screenshot, log) to storage location
	 */
	private async copySnapshotFiles(
		sourceDir: string,
		projectSlug: string,
		buildId: string,
		testName: string,
		result: AggregatedSnapshotResult
	): Promise<void> {
		const destDir = path.join(
			this.repository['storage']['basePath'],
			this.repository['basePath'](projectSlug, buildId),
			'snapshots',
			testName
		);

		await fs.mkdir(destDir, { recursive: true });

		// Copy screenshot
		const screenshotCandidates = [
			result.screenshotPath,
			`${testName}_screenshot.png`,
			'screenshot.png',
			`${testName}.png`,
		].filter(Boolean);

		for (const filename of screenshotCandidates) {
			const sourcePath = path.join(sourceDir, filename as string);
			try {
				await fs.access(sourcePath);
				await fs.copyFile(sourcePath, path.join(destDir, 'screenshot.png'));
				result.screenshotPath = 'screenshot.png';
				break;
			} catch {
				// Try next candidate
			}
		}

		// Copy log file
		const logCandidates = [
			`${testName}_log.txt`,
			'log.txt',
			`${testName}.log`,
		];

		for (const filename of logCandidates) {
			const sourcePath = path.join(sourceDir, filename);
			try {
				await fs.access(sourcePath);
				await fs.copyFile(sourcePath, path.join(destDir, 'log.txt'));
				break;
			} catch {
				// Try next candidate
			}
		}

		// Save result.json to storage
		await fs.writeFile(
			path.join(destDir, 'result.json'),
			JSON.stringify(result, null, 2)
		);
	}

	/**
	 * Get test results for a build
	 */
	async getResults(projectSlug: string, buildId: string): Promise<BuildTestResults | null> {
		return this.repository.getResults(projectSlug, buildId);
	}

	/**
	 * Get unit test output for a build
	 */
	async getUnitTests(projectSlug: string, buildId: string): Promise<UnitTestOutput | null> {
		return this.repository.getUnitTestOutput(projectSlug, buildId);
	}

	/**
	 * Get a specific test suite
	 */
	async getTestSuite(projectSlug: string, buildId: string, suiteName: string): Promise<TestSuite | null> {
		return this.repository.getTestSuite(projectSlug, buildId, suiteName);
	}

	/**
	 * Get all snapshot results for a build
	 */
	async getSnapshotResults(projectSlug: string, buildId: string): Promise<AggregatedSnapshotResult[]> {
		return this.repository.getAllSnapshotResults(projectSlug, buildId);
	}

	/**
	 * Get a specific snapshot result
	 */
	async getSnapshotResult(
		projectSlug: string,
		buildId: string,
		testName: string
	): Promise<AggregatedSnapshotResult | null> {
		return this.repository.getSnapshotResult(projectSlug, buildId, testName);
	}

	/**
	 * Get snapshot log content
	 */
	async getSnapshotLog(projectSlug: string, buildId: string, testName: string): Promise<string | null> {
		return this.repository.getSnapshotLog(projectSlug, buildId, testName);
	}

	/**
	 * Compute test summary from results
	 */
	computeTestSummary(results: BuildTestResults): TestSummary {
		let total = 0;
		let passed = 0;
		let failed = 0;

		if (results.unitTests) {
			total += results.unitTests.summary.total;
			passed += results.unitTests.summary.passed;
			failed += results.unitTests.summary.failed;
		}

		if (results.snapshotTests) {
			total += results.snapshotTests.summary.total;
			passed += results.snapshotTests.summary.passed;
			failed += results.snapshotTests.summary.failed;
		}

		return { total, passed, failed };
	}
}
