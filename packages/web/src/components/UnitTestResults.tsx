import { useState, useMemo } from 'react';
import type { TestSuite, TestResult } from '@banshee-forge/shared';

interface UnitTestResultsProps {
	suites: TestSuite[];
}

type FilterType = 'all' | 'passed' | 'failed';

export function UnitTestResults({ suites }: UnitTestResultsProps) {
	const [expandedSuites, setExpandedSuites] = useState<Set<string>>(new Set());
	const [filter, setFilter] = useState<FilterType>('all');
	const [searchQuery, setSearchQuery] = useState('');

	const filteredSuites = useMemo(() => {
		return suites.map(suite => {
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
			};
		}).filter(suite => suite.tests.length > 0);
	}, [suites, filter, searchQuery]);

	const toggleSuite = (suiteName: string) => {
		setExpandedSuites(prev => {
			const next = new Set(prev);
			if (next.has(suiteName)) {
				next.delete(suiteName);
			} else {
				next.add(suiteName);
			}
			return next;
		});
	};

	const expandAll = () => {
		setExpandedSuites(new Set(suites.map(s => s.name)));
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
						className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
					/>
				</div>

				<select
					value={filter}
					onChange={(e) => setFilter(e.target.value as FilterType)}
					className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
				>
					<option value="all">All Tests</option>
					<option value="passed">Passed Only</option>
					<option value="failed">Failed Only</option>
				</select>

				<div className="flex gap-2">
					<button
						onClick={expandAll}
						className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900"
					>
						Expand All
					</button>
					<button
						onClick={collapseAll}
						className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900"
					>
						Collapse All
					</button>
				</div>
			</div>

			{/* Results */}
			{filteredSuites.length === 0 ? (
				<div className="text-center py-8 text-gray-500">
					No tests match your filter criteria
				</div>
			) : (
				<div className="space-y-2">
					{filteredSuites.map(suite => (
						<div key={suite.name} className="border rounded-lg overflow-hidden">
							{/* Suite Header */}
							<button
								onClick={() => toggleSuite(suite.name)}
								className="w-full px-4 py-3 bg-gray-50 hover:bg-gray-100 flex items-center justify-between text-left"
							>
								<div className="flex items-center gap-3">
									<span className={`transform transition-transform ${expandedSuites.has(suite.name) ? 'rotate-90' : ''}`}>
										▶
									</span>
									<span className="font-medium">{suite.name}</span>
									<span className={`px-2 py-0.5 text-xs rounded-full ${
										suite.failedTests > 0
											? 'bg-red-100 text-red-700'
											: 'bg-green-100 text-green-700'
									}`}>
										{suite.passedTests}/{suite.totalTests}
									</span>
								</div>
								<span className="text-sm text-gray-500">
									{formatDuration(suite.durationUs)}
								</span>
							</button>

							{/* Suite Tests */}
							{expandedSuites.has(suite.name) && (
								<div className="divide-y divide-gray-100">
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
		<div className="bg-white">
			<div
				className={`px-4 py-2 flex items-center justify-between ${test.failures?.length ? 'cursor-pointer hover:bg-gray-50' : ''}`}
				onClick={() => test.failures?.length && setExpanded(!expanded)}
			>
				<div className="flex items-center gap-3">
					{test.passed ? (
						<span className="text-green-500">✓</span>
					) : (
						<span className="text-red-500">✗</span>
					)}
					<span className={test.passed ? 'text-gray-700' : 'text-red-700 font-medium'}>
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
						<div key={index} className="mt-2 p-3 bg-red-50 rounded-md text-sm">
							<p className="text-red-800">{failure.description}</p>
							<p className="text-red-600 mt-1 font-mono text-xs">
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
