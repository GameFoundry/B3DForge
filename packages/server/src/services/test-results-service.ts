import { promises as fs } from 'fs';
import path from 'path';
import type {
	BuildTestResults,
	UnitTestOutput,
	AggregatedSnapshotResult,
	SnapshotCategoriesManifest,
	TestSummary,
	TestSuite
} from '@banshee-forge/shared';
import { DEFAULT_SNAPSHOT_CATEGORY } from '@banshee-forge/shared';
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
	 * Expected directory structure (categories declared out-of-band via markers, see below):
	 * resultsDir/
	 * ├── unit_tests.json         # or test_results.json
	 * └── snapshots/
	 *     ├── Vulkan/
	 *     │   ├── Lighting/
	 *     │   │   ├── Lighting_result.json
	 *     │   │   ├── Lighting_screenshot.png
	 *     │   │   └── Lighting_log.txt
	 *     │   └── ...
	 *     └── D3D12/
	 *         └── ...
	 *
	 * Categories are declared by the test script via `::snapshot-category::` markers,
	 * parsed from stdout by the agent and passed in as `declaredCategories`. When none
	 * are provided the flat layout snapshots/{testName}/ is parsed instead, attributed
	 * to DEFAULT_SNAPSHOT_CATEGORY (a snapshots/categories.json manifest, if present, is
	 * honored as a defensive fallback before falling back to flat).
	 *
	 * @param	declaredCategories	Ordered snapshot categories from the agent's marker parsing.
	 */
	async parseAndStoreResults(
		projectSlug: string,
		buildId: string,
		resultsDir: string,
		declaredCategories?: string[]
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
		const { results: snapshotResults, categories } = await this.parseSnapshotTests(
			resultsDir, projectSlug, buildId, declaredCategories
		);
		if (snapshotResults.length > 0) {
			const passed = snapshotResults.filter(r => r.statusText === 'passed').length;
			const failed = snapshotResults.filter(r =>
				r.statusText === 'failed' || r.statusText === 'crashed'
			).length;

			results.snapshotTests = {
				results: snapshotResults,
				summary: {
					total: snapshotResults.length,
					passed,
					failed,
				},
				categories,
			};

			// Save individual snapshot results
			for (const result of snapshotResults) {
				await this.repository.saveSnapshotResult(
					projectSlug,
					buildId,
					result.category ?? DEFAULT_SNAPSHOT_CATEGORY,
					result.testName,
					result
				);
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
		const destDir = this.repository.getUnitTestAbsoluteDir(projectSlug, buildId);

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
	 * Parse the category manifest (snapshots/categories.json) written by the test script.
	 * Returns null when absent or invalid, in which case the legacy flat layout is assumed.
	 */
	private async parseCategoriesManifest(snapshotsDir: string): Promise<SnapshotCategoriesManifest | null> {
		const manifestPath = path.join(snapshotsDir, 'categories.json');
		try {
			let content = await fs.readFile(manifestPath, 'utf-8');
			// Strip UTF-8 BOM if present
			if (content.charCodeAt(0) === 0xFEFF) {
				content = content.slice(1);
			}
			const parsed = JSON.parse(content);

			if (
				parsed.type === 'snapshot_categories' &&
				Array.isArray(parsed.categories) &&
				parsed.categories.every((c: any) => typeof c?.name === 'string' && c.name.length > 0)
			) {
				return parsed as SnapshotCategoriesManifest;
			}
		} catch {
			// File doesn't exist or isn't valid JSON
		}

		return null;
	}

	/**
	 * Parse snapshot test results from the results directory.
	 *
	 * Category list precedence:
	 *   1. `declaredCategories` — from the script's `::snapshot-category::` markers (parsed by the agent).
	 *   2. A snapshots/categories.json manifest, if present (defensive fallback for agent/script skew).
	 * With either, tests are read from the nested snapshots/{category}/{testName}/ layout. When
	 * neither is available the legacy flat snapshots/{testName}/ layout is parsed under
	 * DEFAULT_SNAPSHOT_CATEGORY. Returns the results plus the ordered category list.
	 */
	private async parseSnapshotTests(
		resultsDir: string,
		projectSlug: string,
		buildId: string,
		declaredCategories?: string[]
	): Promise<{ results: AggregatedSnapshotResult[]; categories: string[] }> {
		const snapshotsDir = path.join(resultsDir, 'snapshots');
		const results: AggregatedSnapshotResult[] = [];

		// Determine the ordered category list and whether the layout is nested (categorized)
		// or the legacy flat layout.
		let categories: string[] | null =
			declaredCategories && declaredCategories.length > 0 ? declaredCategories : null;
		if (!categories) {
			const manifest = await this.parseCategoriesManifest(snapshotsDir);
			categories = manifest ? manifest.categories.map(c => c.name) : null;
		}
		const isNested = categories !== null;
		const effectiveCategories = categories ?? [DEFAULT_SNAPSHOT_CATEGORY];

		for (const category of effectiveCategories) {
			// Legacy (flat) layout has no category directory level
			const categoryDir = isNested ? path.join(snapshotsDir, category) : snapshotsDir;

			try {
				const entries = await fs.readdir(categoryDir, { withFileTypes: true });

				for (const entry of entries) {
					if (!entry.isDirectory()) continue;

					const testName = entry.name;
					const testDir = path.join(categoryDir, testName);
					const result = await this.parseSnapshotTestDir(testDir, projectSlug, buildId, category, testName);
					results.push(result);
				}
			} catch {
				// Category (or snapshots) directory doesn't exist, that's fine
			}
		}

		return { results, categories: results.length > 0 ? effectiveCategories : [] };
	}

	/**
	 * Parse a single test's output directory into a result, synthesizing a crashed or
	 * passed result when no result.json was produced. Copies files into storage.
	 */
	private async parseSnapshotTestDir(
		testDir: string,
		projectSlug: string,
		buildId: string,
		category: string,
		testName: string
	): Promise<AggregatedSnapshotResult> {
		// Find result.json file (may be named {testName}_result.json or result.json)
		const result = await this.parseSnapshotResult(testDir, testName);
		if (result) {
			result.category = category;
			// Copy files to storage and update paths
			await this.copySnapshotFiles(testDir, projectSlug, buildId, category, testName, result);
			return result;
		}

		// No result.json found - check log for actual error indicators before assuming crashed
		const hasErrors = await this.logContainsErrors(testDir, testName);
		if (hasErrors) {
			return this.createCrashedSnapshotResult(testDir, projectSlug, buildId, category, testName);
		}

		// Test exited cleanly but produced no result.json
		const passedResult: AggregatedSnapshotResult = {
			type: 'snapshot_test',
			testName,
			category,
			status: 0,
			statusText: 'passed',
			totalFrames: 0,
			executionTimeSeconds: 0,
			screenshotPath: '',
			errors: [],
			warnings: ['No result.json was produced by the test'],
		};
		await this.copyCrashedSnapshotFiles(testDir, projectSlug, buildId, category, testName, passedResult);
		return passedResult;
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
		category: string,
		testName: string,
		result: AggregatedSnapshotResult
	): Promise<void> {
		const destDir = this.repository.getSnapshotAbsoluteDir(projectSlug, buildId, category, testName);

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
	 * Create a synthetic result for a crashed snapshot test
	 */
	private async createCrashedSnapshotResult(
		testDir: string,
		projectSlug: string,
		buildId: string,
		category: string,
		testName: string
	): Promise<AggregatedSnapshotResult> {
		const errors: string[] = [];

		// Try to extract error info from log.txt if it exists
		const logCandidates = [`${testName}_log.txt`, 'log.txt', `${testName}.log`];

		let logContent: string | null = null;
		for (const filename of logCandidates) {
			const logPath = path.join(testDir, filename);
			try {
				logContent = await fs.readFile(logPath, 'utf-8');
				break;
			} catch {
				// Try next candidate
			}
		}

		// Extract last few lines from log if available
		if (logContent) {
			const lines = logContent.trim().split('\n');
			const lastLines = lines.slice(-10);
			const errorLines = lastLines.filter(line =>
				/error|crash|exception|failed|abort|segfault|access violation/i.test(line)
			);
			if (errorLines.length > 0) {
				errors.push(...errorLines.slice(0, 5));
			} else if (lines.length > 0) {
				errors.push(`Test crashed. Last log line: ${lines[lines.length - 1]}`);
			}
		}

		if (errors.length === 0) {
			errors.push('Test crashed without producing result.json');
		}

		const crashedResult: AggregatedSnapshotResult = {
			type: 'snapshot_test',
			testName,
			category,
			status: -1,
			statusText: 'crashed',
			totalFrames: 0,
			executionTimeSeconds: 0,
			screenshotPath: '',
			errors,
			warnings: [],
		};

		// Copy any available files and save result
		await this.copyCrashedSnapshotFiles(testDir, projectSlug, buildId, category, testName, crashedResult);

		return crashedResult;
	}

	/**
	 * Check if a snapshot test's log contains error indicators.
	 * Returns true if the log has error/crash/exception keywords, false otherwise.
	 */
	private async logContainsErrors(testDir: string, testName: string): Promise<boolean> {
		const logCandidates = [`${testName}_log.txt`, 'log.txt', `${testName}.log`];

		for (const filename of logCandidates) {
			const logPath = path.join(testDir, filename);
			try {
				const logContent = await fs.readFile(logPath, 'utf-8');
				const lines = logContent.trim().split('\n');
				return lines.some(line =>
					/error|crash|exception|abort|segfault|access violation/i.test(line)
				);
			} catch {
				// Try next candidate
			}
		}

		// No log file found - assume crashed
		return true;
	}

	/**
	 * Copy available files for a crashed snapshot test
	 */
	private async copyCrashedSnapshotFiles(
		sourceDir: string,
		projectSlug: string,
		buildId: string,
		category: string,
		testName: string,
		result: AggregatedSnapshotResult
	): Promise<void> {
		const destDir = this.repository.getSnapshotAbsoluteDir(projectSlug, buildId, category, testName);

		await fs.mkdir(destDir, { recursive: true });

		// Copy any screenshot that might exist
		const screenshotCandidates = [
			`${testName}_screenshot.png`,
			'screenshot.png',
			`${testName}.png`,
		];

		for (const filename of screenshotCandidates) {
			const sourcePath = path.join(sourceDir, filename);
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
		const logCandidates = [`${testName}_log.txt`, 'log.txt', `${testName}.log`];

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

		// Save result.json
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
		category: string,
		testName: string
	): Promise<AggregatedSnapshotResult | null> {
		return this.repository.getSnapshotResult(projectSlug, buildId, category, testName);
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
		return this.repository.getSnapshotLog(projectSlug, buildId, category, testName);
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
