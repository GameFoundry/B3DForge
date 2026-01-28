import { useState } from 'react';
import { useTestResults } from '../hooks/useTestResults';
import { UnitTestResults } from './UnitTestResults';
import { SnapshotTestResults } from './SnapshotTestResults';

interface TestResultsTabProps {
	buildId: string;
	projectSlug: string;
	configurationId: string;
}

type TabType = 'unit' | 'snapshots';

export function TestResultsTab({ buildId, projectSlug, configurationId }: TestResultsTabProps) {
	const [activeTab, setActiveTab] = useState<TabType>('unit');
	const { data: results, isLoading, error } = useTestResults(buildId);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-48">
				<div className="text-gray-500">Loading test results...</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-4 bg-red-50 border border-red-200 rounded-lg">
				<p className="text-red-700">Failed to load test results: {error.message}</p>
			</div>
		);
	}

	const hasUnitTests = results?.unitTests && results.unitTests.suites.length > 0;
	const hasSnapshots = results?.snapshotTests && results.snapshotTests.results.length > 0;
	const noResults = !hasUnitTests && !hasSnapshots;

	if (noResults) {
		return (
			<div className="flex flex-col items-center justify-center h-48 text-gray-500">
				<svg className="w-12 h-12 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
				</svg>
				<p>No test results found for this build</p>
				<p className="text-sm mt-1">Test results will appear here after the test phase completes</p>
			</div>
		);
	}

	const unitSummary = results?.unitTests?.summary;
	const snapshotSummary = results?.snapshotTests?.summary;

	return (
		<div className="space-y-4">
			{/* Summary Cards */}
			<div className="grid grid-cols-2 gap-4">
				{hasUnitTests && unitSummary && (
					<div className="bg-white border rounded-lg p-4">
						<h3 className="text-sm font-medium text-gray-500 mb-2">Unit Tests</h3>
						<div className="flex items-baseline space-x-4">
							<span className="text-2xl font-bold text-gray-900">
								{unitSummary.passed}/{unitSummary.total}
							</span>
							{unitSummary.failed > 0 && (
								<span className="text-red-600 font-medium">
									{unitSummary.failed} failed
								</span>
							)}
							{unitSummary.failed === 0 && (
								<span className="text-green-600 font-medium">
									All passed
								</span>
							)}
						</div>
					</div>
				)}

				{hasSnapshots && snapshotSummary && (
					<div className="bg-white border rounded-lg p-4">
						<h3 className="text-sm font-medium text-gray-500 mb-2">Snapshot Tests</h3>
						<div className="flex items-baseline space-x-4">
							<span className="text-2xl font-bold text-gray-900">
								{snapshotSummary.passed}/{snapshotSummary.total}
							</span>
							{snapshotSummary.failed > 0 && (
								<span className="text-red-600 font-medium">
									{snapshotSummary.failed} failed
								</span>
							)}
							{snapshotSummary.failed === 0 && (
								<span className="text-green-600 font-medium">
									All passed
								</span>
							)}
						</div>
					</div>
				)}
			</div>

			{/* Tab Navigation */}
			<div className="border-b border-gray-200">
				<nav className="-mb-px flex space-x-8">
					{hasUnitTests && (
						<button
							onClick={() => setActiveTab('unit')}
							className={`py-2 px-1 border-b-2 font-medium text-sm ${
								activeTab === 'unit'
									? 'border-blue-500 text-blue-600'
									: 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
							}`}
						>
							Unit Tests
							{unitSummary && (
								<span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-gray-100">
									{unitSummary.total}
								</span>
							)}
						</button>
					)}

					{hasSnapshots && (
						<button
							onClick={() => setActiveTab('snapshots')}
							className={`py-2 px-1 border-b-2 font-medium text-sm ${
								activeTab === 'snapshots'
									? 'border-blue-500 text-blue-600'
									: 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
							}`}
						>
							Snapshot Tests
							{snapshotSummary && (
								<span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-gray-100">
									{snapshotSummary.total}
								</span>
							)}
						</button>
					)}
				</nav>
			</div>

			{/* Tab Content */}
			<div className="pt-4">
				{activeTab === 'unit' && hasUnitTests && results?.unitTests && (
					<UnitTestResults suites={results.unitTests.suites} />
				)}

				{activeTab === 'snapshots' && hasSnapshots && results?.snapshotTests && (
					<SnapshotTestResults
						results={results.snapshotTests.results}
						buildId={buildId}
						projectSlug={projectSlug}
						configurationId={configurationId}
					/>
				)}
			</div>
		</div>
	);
}
