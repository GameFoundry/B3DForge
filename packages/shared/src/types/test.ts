/** Test failure info */
export interface TestFailure {
  description: string;
  function?: string;
  file: string;
  line: number;
}

/** Individual test result */
export interface TestResult {
  name: string;
  passed: boolean;
  durationUs: number;
  failures?: TestFailure[];
}

/** Test suite */
export interface TestSuite {
  name: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  durationUs: number;
  tests: TestResult[];
}

/** Unit test output (from JSONTestOutput) */
export interface UnitTestOutput {
  type: 'unit_test';
  timestamp: string;
  suites: TestSuite[];
  summary: {
    totalSuites: number;
    totalTests: number;
    passedTests: number;
    failedTests: number;
    totalDurationUs: number;
  };
}

/** Snapshot test status */
export type SnapshotTestStatus = 'passed' | 'failed' | 'passed_with_warnings';

/** Snapshot test result (from SnapshotTestRunner) */
export interface SnapshotTestResult {
  type: 'snapshot_test';
  testName: string;
  status: number;
  statusText: SnapshotTestStatus;
  totalFrames: number;
  executionTimeSeconds: number;
  screenshotPath: string;
  errors: string[];
  warnings: string[];
}

/** Aggregated snapshot result (with comparison data) */
export interface AggregatedSnapshotResult extends SnapshotTestResult {
  referencePath?: string;
  diffPath?: string;
  diffPercentage?: number;
}

/** Aggregated test results for a build */
export interface BuildTestResults {
  buildId: string;
  unitTests?: {
    source: string;
    summary: { total: number; passed: number; failed: number };
    suites: TestSuite[];
  };
  snapshotTests?: {
    results: AggregatedSnapshotResult[];
    summary: { total: number; passed: number; failed: number };
  };
}
