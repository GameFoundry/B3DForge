import { useState, useMemo } from 'react';
import type { AggregatedSnapshotResult, SnapshotTestStatus } from '@banshee-forge/shared';
import { testsApi } from '../api/client';
import { SnapshotComparisonModal } from './SnapshotComparisonModal';

interface SnapshotTestResultsProps {
	results: AggregatedSnapshotResult[];
	buildId: string;
	projectSlug: string;
	configurationId: string;
}

type FilterType = 'all' | 'passed' | 'failed';
type ViewMode = 'grid' | 'list';

const statusColors: Record<SnapshotTestStatus, string> = {
	passed: 'bg-green-900/50 text-green-300 border-green-800',
	failed: 'bg-red-900/50 text-red-300 border-red-800',
	passed_with_warnings: 'bg-yellow-900/50 text-yellow-300 border-yellow-800',
};

const statusIcons: Record<SnapshotTestStatus, string> = {
	passed: '✓',
	failed: '✗',
	passed_with_warnings: '⚠',
};

export function SnapshotTestResults({ results, buildId, projectSlug, configurationId }: SnapshotTestResultsProps) {
	const [filter, setFilter] = useState<FilterType>('all');
	const [viewMode, setViewMode] = useState<ViewMode>('grid');
	const [searchQuery, setSearchQuery] = useState('');
	const [selectedTest, setSelectedTest] = useState<string | null>(null);

	const filteredResults = useMemo(() => {
		return results.filter(result => {
			// Filter by status
			if (filter === 'passed' && result.statusText !== 'passed') return false;
			if (filter === 'failed' && result.statusText !== 'failed') return false;

			// Filter by search
			if (searchQuery) {
				const query = searchQuery.toLowerCase();
				return result.testName.toLowerCase().includes(query);
			}

			return true;
		});
	}, [results, filter, searchQuery]);

	return (
		<div className="space-y-4">
			{/* Filters */}
			<div className="flex items-center gap-4">
				<div className="flex-1">
					<input
						type="text"
						placeholder="Search snapshots..."
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
					<option value="all">All Snapshots</option>
					<option value="passed">Passed Only</option>
					<option value="failed">Failed Only</option>
				</select>

				<div className="flex border border-gray-600 rounded-md overflow-hidden">
					<button
						onClick={() => setViewMode('grid')}
						className={`px-3 py-2 text-sm ${viewMode === 'grid' ? 'bg-blue-900/50 text-blue-300' : 'text-gray-400 hover:bg-gray-700'}`}
					>
						Grid
					</button>
					<button
						onClick={() => setViewMode('list')}
						className={`px-3 py-2 text-sm border-l border-gray-600 ${viewMode === 'list' ? 'bg-blue-900/50 text-blue-300' : 'text-gray-400 hover:bg-gray-700'}`}
					>
						List
					</button>
				</div>
			</div>

			{/* Results */}
			{filteredResults.length === 0 ? (
				<div className="text-center py-8 text-gray-500">
					No snapshots match your filter criteria
				</div>
			) : viewMode === 'grid' ? (
				<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
					{filteredResults.map(result => (
						<SnapshotCard
							key={result.testName}
							result={result}
							buildId={buildId}
							onClick={() => setSelectedTest(result.testName)}
						/>
					))}
				</div>
			) : (
				<div className="space-y-2">
					{filteredResults.map(result => (
						<SnapshotListItem
							key={result.testName}
							result={result}
							onClick={() => setSelectedTest(result.testName)}
						/>
					))}
				</div>
			)}

			{/* Comparison Modal */}
			{selectedTest && (
				<SnapshotComparisonModal
					buildId={buildId}
					testName={selectedTest}
					projectSlug={projectSlug}
					configurationId={configurationId}
					onClose={() => setSelectedTest(null)}
				/>
			)}
		</div>
	);
}

function SnapshotCard({
	result,
	buildId,
	onClick,
}: {
	result: AggregatedSnapshotResult;
	buildId: string;
	onClick: () => void;
}) {
	const screenshotUrl = testsApi.getScreenshotUrl(buildId, result.testName);

	return (
		<div
			onClick={onClick}
			className="border border-gray-700 rounded-lg overflow-hidden cursor-pointer hover:border-gray-600 transition-colors bg-gray-800"
		>
			{/* Thumbnail */}
			<div className="aspect-video bg-gray-900 relative">
				<img
					src={screenshotUrl}
					alt={result.testName}
					className="w-full h-full object-cover"
					onError={(e) => {
						(e.target as HTMLImageElement).style.display = 'none';
					}}
				/>
			</div>

			{/* Info */}
			<div className="p-3">
				<div className="flex items-center justify-between">
					<h4 className="font-medium text-sm truncate text-gray-100" title={result.testName}>
						{result.testName}
					</h4>
					<span className={`px-2 py-0.5 text-xs rounded-full border ${statusColors[result.statusText]}`}>
						{statusIcons[result.statusText]} {result.statusText.replace('_', ' ')}
					</span>
				</div>

				{(result.errors.length > 0 || result.warnings.length > 0) && (
					<div className="mt-2 text-xs text-gray-500">
						{result.errors.length > 0 && (
							<span className="text-red-400">{result.errors.length} error(s)</span>
						)}
						{result.errors.length > 0 && result.warnings.length > 0 && ' · '}
						{result.warnings.length > 0 && (
							<span className="text-yellow-400">{result.warnings.length} warning(s)</span>
						)}
					</div>
				)}

				{result.diffPercentage !== undefined && result.diffPercentage > 0 && (
					<div className="mt-1 text-xs text-red-400">
						{result.diffPercentage.toFixed(2)}% difference
					</div>
				)}
			</div>
		</div>
	);
}

function SnapshotListItem({
	result,
	onClick,
}: {
	result: AggregatedSnapshotResult;
	onClick: () => void;
}) {
	return (
		<div
			onClick={onClick}
			className="border border-gray-700 rounded-lg p-4 cursor-pointer hover:bg-gray-750 bg-gray-800 flex items-center justify-between"
		>
			<div className="flex items-center gap-4">
				<span className={`px-2 py-1 text-sm rounded-full border ${statusColors[result.statusText]}`}>
					{statusIcons[result.statusText]}
				</span>
				<div>
					<h4 className="font-medium text-gray-100">{result.testName}</h4>
					<div className="text-sm text-gray-500">
						{result.totalFrames} frames · {result.executionTimeSeconds.toFixed(2)}s
					</div>
				</div>
			</div>

			<div className="flex items-center gap-4">
				{result.diffPercentage !== undefined && result.diffPercentage > 0 && (
					<span className="text-red-400 text-sm font-medium">
						{result.diffPercentage.toFixed(2)}% diff
					</span>
				)}

				{(result.errors.length > 0 || result.warnings.length > 0) && (
					<div className="text-sm">
						{result.errors.length > 0 && (
							<span className="text-red-400 mr-2">{result.errors.length} errors</span>
						)}
						{result.warnings.length > 0 && (
							<span className="text-yellow-400">{result.warnings.length} warnings</span>
						)}
					</div>
				)}

				<span className="text-gray-500">→</span>
			</div>
		</div>
	);
}
