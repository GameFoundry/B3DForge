import { useState, useMemo } from 'react';
import type { TestSuite, TestResult } from '@banshee-forge/shared';
import { useUnitTestLog } from '../hooks/useTestResults';

interface UnitTestResultsProps {
	suites: TestSuite[];
	buildId: string;
}

type FilterType = 'all' | 'passed' | 'failed';

export function UnitTestResults({ suites, buildId }: UnitTestResultsProps) {
	const [expandedSuites, setExpandedSuites] = useState<Set<string>>(new Set());
	const [filter, setFilter] = useState<FilterType>('all');
	const [searchQuery, setSearchQuery] = useState('');
	const [showLog, setShowLog] = useState(false);
	const { data: log, isLoading: logLoading, error: logError } = useUnitTestLog(buildId, showLog);

	const filteredSuites = useMemo(() => {
		return suites.map((suite, index) => {
			let filteredTests = suite.tests;

			// Filter by status
			if (filter === 'passed') {
				filteredTests = filteredTests.filter(t => t.passed);
			} else if (filter === 'failed') {
				filteredTests = filteredTests.filter(t => !t.passed);
			}

			// Filter by search
			if (searchQuery) {
				const query = searchQuery.toLowerCase();
				filteredTests = filteredTests.filter(t =>
					t.name.toLowerCase().includes(query) ||
					suite.name.toLowerCase().includes(query)
				);
			}

			return {
				...suite,
				tests: filteredTests,
				// Use original index as unique ID since suite names may not be unique
				id: `suite-${index}`,
			};
		}).filter(suite => suite.tests.length > 0);
	}, [suites, filter, searchQuery]);

	const toggleSuite = (suiteId: string) => {
		setExpandedSuites(prev => {
			const next = new Set(prev);
			if (next.has(suiteId)) {
				next.delete(suiteId);
			} else {
				next.add(suiteId);
			}
			return next;
		});
	};

	const expandAll = () => {
		setExpandedSuites(new Set(filteredSuites.map(s => s.id)));
	};

	const collapseAll = () => {
		setExpandedSuites(new Set());
	};

	const formatDuration = (microseconds: number) => {
		if (microseconds < 1000) return `${microseconds}µs`;
		if (microseconds < 1000000) return `${(microseconds / 1000).toFixed(1)}ms`;
		return `${(microseconds / 1000000).toFixed(2)}s`;
	};

	return (
		<div className="space-y-4">
			{/* Filters */}
			<div className="flex items-center gap-4">
				<div className="flex-1">
					<input
						type="text"
						placeholder="Search tests..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-md text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
					/>
				</div>

				<select
					value={filter}
					onChange={(e) => setFilter(e.target.value as FilterType)}
					className="px-3 py-2 bg-gray-800 border border-gray-600 rounded-md text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
				>
					<option value="all">All Tests</option>
					<option value="passed">Passed Only</option>
					<option value="failed">Failed Only</option>
				</select>

				<div className="flex gap-2">
					<button
						onClick={expandAll}
						className="px-3 py-2 text-sm text-gray-400 hover:text-gray-200"
					>
						Expand All
					</button>
					<button
						onClick={collapseAll}
						className="px-3 py-2 text-sm text-gray-400 hover:text-gray-200"
					>
						Collapse All
					</button>
				</div>
			</div>

			{/* Console Output - Collapsible section */}
			<div className="border border-gray-700 rounded-lg overflow-hidden">
				<button
					onClick={() => setShowLog(!showLog)}
					className="w-full px-4 py-3 bg-gray-800 hover:bg-gray-750 flex items-center justify-between text-left"
				>
					<div className="flex items-center gap-3">
						{/* Terminal icon */}
						<svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
						</svg>
						<span className="font-medium text-gray-100">Console Output</span>
					</div>
					<svg className={`w-4 h-4 text-gray-400 transform transition-transform ${showLog ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
					</svg>
				</button>

				{showLog && (
					<div className="p-4 max-h-96 overflow-y-auto bg-gray-900 border-t border-gray-700">
						{logLoading ? (
							<div className="text-gray-500 text-sm">Loading console output...</div>
						) : logError ? (
							<div className="text-gray-500 text-sm">No console output available.</div>
						) : log ? (
							<pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-words">
								{log}
							</pre>
						) : (
							<div className="text-gray-500 text-sm">No console output available.</div>
						)}
					</div>
				)}
			</div>

			{/* Results */}
			{filteredSuites.length === 0 ? (
				<div className="text-center py-8 text-gray-500">
					No tests match your filter criteria
				</div>
			) : (
				<div className="space-y-2">
					{filteredSuites.map(suite => (
						<div key={suite.id} className="border border-gray-700 rounded-lg overflow-hidden">
							{/* Suite Header */}
							<button
								onClick={() => toggleSuite(suite.id)}
								className="w-full px-4 py-3 bg-gray-800 hover:bg-gray-750 flex items-center justify-between text-left"
							>
								<div className="flex items-center gap-3">
									<span className={`transform transition-transform text-gray-400 ${expandedSuites.has(suite.id) ? 'rotate-90' : ''}`}>
										▶
									</span>
									<span className="font-medium text-gray-100">{suite.name}</span>
									<span className={`px-2 py-0.5 text-xs rounded-full ${
										suite.failedTests > 0
											? 'bg-red-900/50 text-red-300'
											: 'bg-green-900/50 text-green-300'
									}`}>
										{suite.passedTests}/{suite.totalTests}
									</span>
								</div>
								<span className="text-sm text-gray-500">
									{formatDuration(suite.durationUs)}
								</span>
							</button>

							{/* Suite Tests */}
							{expandedSuites.has(suite.id) && (
								<div className="divide-y divide-gray-700">
									{suite.tests.map((test, index) => (
										<TestResultRow key={index} test={test} formatDuration={formatDuration} />
									))}
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function TestResultRow({ test, formatDuration }: { test: TestResult; formatDuration: (us: number) => string }) {
	const [expanded, setExpanded] = useState(!test.passed && !!test.failures?.length);

	return (
		<div className="bg-gray-850">
			<div
				className={`px-4 py-2 flex items-center justify-between ${test.failures?.length ? 'cursor-pointer hover:bg-gray-800' : ''}`}
				onClick={() => test.failures?.length && setExpanded(!expanded)}
			>
				<div className="flex items-center gap-3">
					{test.passed ? (
						<span className="text-green-400">✓</span>
					) : (
						<span className="text-red-400">✗</span>
					)}
					<span className={test.passed ? 'text-gray-300' : 'text-red-400 font-medium'}>
						{test.name}
					</span>
				</div>
				<span className="text-sm text-gray-500">
					{formatDuration(test.durationUs)}
				</span>
			</div>

			{/* Failure Details */}
			{expanded && test.failures && test.failures.length > 0 && (
				<div className="px-4 pb-3 pl-10">
					{test.failures.map((failure, index) => (
						<div key={index} className="mt-2 p-3 bg-red-900/30 border border-red-800 rounded-md text-sm">
							<p className="text-red-300">{failure.description}</p>
							<p className="text-red-400 mt-1 font-mono text-xs">
								{failure.file}:{failure.line}
								{failure.function && ` in ${failure.function}`}
							</p>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
