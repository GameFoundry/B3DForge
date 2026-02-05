import { useEffect } from 'react';
import { useSnapshotComparison, useSnapshotDetails, useSnapshotLog, useSetReference } from '../hooks/useTestResults';
import { testsApi, referencesApi } from '../api/client';
import { ImageComparisonViewer } from './ImageComparisonViewer';

interface SnapshotComparisonModalProps {
	buildId: string;
	testName: string;
	projectSlug: string;
	configurationId: string;
	onClose: () => void;
}

export function SnapshotComparisonModal({
	buildId,
	testName,
	projectSlug,
	configurationId,
	onClose,
}: SnapshotComparisonModalProps) {
	const { data: comparison, isLoading: comparisonLoading } = useSnapshotComparison(buildId, testName);
	const { data: details, isLoading: detailsLoading } = useSnapshotDetails(buildId, testName);
	const { data: log, isLoading: logLoading } = useSnapshotLog(buildId, testName);
	const setReferenceMutation = useSetReference();

	// Close on escape key
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [onClose]);

	// Prevent body scroll when modal is open
	useEffect(() => {
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = '';
		};
	}, []);

	const isLoading = comparisonLoading || detailsLoading;

	const screenshotUrl = testsApi.getScreenshotUrl(buildId, testName);
	const referenceUrl = comparison?.hasReference
		? referencesApi.getReferenceUrl(projectSlug, configurationId, testName)
		: undefined;
	const diffUrl = comparison?.hasReference && comparison.diffImagePath
		? testsApi.getDiffUrl(buildId, testName)
		: undefined;

	const handleSetAsReference = async () => {
		try {
			await setReferenceMutation.mutateAsync({
				projectSlug,
				configId: configurationId,
				testName,
				buildId,
			});
		} catch (error) {
			console.error('Failed to set reference:', error);
		}
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
			{/* Modal Container */}
			<div className="w-full h-full max-w-7xl max-h-[90vh] m-4 bg-gray-900 rounded-lg shadow-xl flex flex-col overflow-hidden border border-gray-700">
				{/* Header */}
				<div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 bg-gray-800">
					<div className="flex items-center gap-4">
						<h2 className="text-lg font-semibold text-gray-100">{testName}</h2>
						{details && (
							<span className={`px-2 py-1 text-sm rounded-full ${
								details.statusText === 'passed'
									? 'bg-green-900/50 text-green-300'
									: details.statusText === 'failed'
										? 'bg-red-900/50 text-red-300'
										: details.statusText === 'crashed'
											? 'bg-purple-900/50 text-purple-300'
											: 'bg-yellow-900/50 text-yellow-300'
							}`}>
								{details.statusText.replace('_', ' ')}
							</span>
						)}
					</div>

					<div className="flex items-center gap-3">
						{/* Set as Reference Button */}
						<button
							onClick={handleSetAsReference}
							disabled={setReferenceMutation.isPending || details?.statusText === 'crashed'}
							className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
						>
							{setReferenceMutation.isPending ? 'Setting...' : 'Set as Reference'}
						</button>

						{/* Close Button */}
						<button
							onClick={onClose}
							className="p-1.5 text-gray-400 hover:text-gray-200 rounded hover:bg-gray-700"
							title="Close (Esc)"
						>
							<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					</div>
				</div>

				{/* Content */}
				<div className="flex-1 flex overflow-hidden">
					{/* Main Viewer */}
					<div className="flex-1 flex flex-col">
						{isLoading ? (
							<div className="flex-1 flex items-center justify-center">
								<div className="text-gray-500">Loading...</div>
							</div>
						) : (
							<ImageComparisonViewer
								currentUrl={screenshotUrl}
								referenceUrl={referenceUrl}
								diffUrl={diffUrl}
								diffPercentage={comparison?.hasReference ? comparison.diffPercentage : undefined}
								log={log}
								logLoading={logLoading}
								defaultMode={details?.statusText === 'crashed' ? 'log' : undefined}
							/>
						)}
					</div>

					{/* Sidebar */}
					<div className="w-72 border-l border-gray-700 bg-gray-800 overflow-y-auto">
						<div className="p-4 space-y-4">
							{/* Test Info */}
							{details && (
								<div>
									<h3 className="text-sm font-medium text-gray-400 mb-2">Test Info</h3>
									<dl className="space-y-1 text-sm">
										<div className="flex justify-between">
											<dt className="text-gray-500">Frames</dt>
											<dd className="text-gray-200">{details.totalFrames}</dd>
										</div>
										<div className="flex justify-between">
											<dt className="text-gray-500">Duration</dt>
											<dd className="text-gray-200">{details.executionTimeSeconds.toFixed(2)}s</dd>
										</div>
									</dl>
								</div>
							)}

							{/* Crash Info */}
							{details?.statusText === 'crashed' && (
								<div className="p-3 bg-purple-900/30 border border-purple-700 rounded">
									<h3 className="text-sm font-medium text-purple-300 mb-1">Test Crashed</h3>
									<p className="text-xs text-gray-400">
										This test crashed without producing results. Check the console output below for details.
									</p>
								</div>
							)}

							{/* Comparison Info */}
							{comparison && (
								<div>
									<h3 className="text-sm font-medium text-gray-400 mb-2">Comparison</h3>
									{comparison.hasReference ? (
										<dl className="space-y-1 text-sm">
											<div className="flex justify-between">
												<dt className="text-gray-500">Match</dt>
												<dd className={comparison.match ? 'text-green-400' : 'text-red-400'}>
													{comparison.match ? 'Yes' : 'No'}
												</dd>
											</div>
											<div className="flex justify-between">
												<dt className="text-gray-500">Difference</dt>
												<dd className="text-gray-200">{comparison.diffPercentage?.toFixed(4)}%</dd>
											</div>
											{comparison.diffPixels !== undefined && comparison.diffPixels > 0 && (
												<div className="flex justify-between">
													<dt className="text-gray-500">Diff Pixels</dt>
													<dd className="text-gray-200">{comparison.diffPixels.toLocaleString()}</dd>
												</div>
											)}
										</dl>
									) : (
										<p className="text-sm text-gray-400">
											No reference image set. Click "Set as Reference" to use this screenshot as the baseline.
										</p>
									)}
								</div>
							)}

							{/* Errors (hidden for crashed tests - the log view has the details) */}
							{details?.statusText !== 'crashed' && details?.errors && details.errors.length > 0 && (
								<div>
									<h3 className="text-sm font-medium text-red-400 mb-2">
										Errors ({details.errors.length})
									</h3>
									<ul className="space-y-1">
										{details.errors.map((error, i) => (
											<li key={i} className="text-sm text-red-300 bg-red-900/30 border border-red-800 p-2 rounded">
												{error}
											</li>
										))}
									</ul>
								</div>
							)}

							{/* Warnings */}
							{details?.warnings && details.warnings.length > 0 && (
								<div>
									<h3 className="text-sm font-medium text-yellow-400 mb-2">
										Warnings ({details.warnings.length})
									</h3>
									<ul className="space-y-1">
										{details.warnings.map((warning, i) => (
											<li key={i} className="text-sm text-yellow-300 bg-yellow-900/30 border border-yellow-800 p-2 rounded">
												{warning}
											</li>
										))}
									</ul>
								</div>
							)}

							{/* Actions */}
							<div className="pt-4 border-t border-gray-700">
								<h3 className="text-sm font-medium text-gray-400 mb-2">Actions</h3>
								<div className="space-y-2">
									<a
										href={screenshotUrl}
										download={`${testName}_screenshot.png`}
										className="block w-full px-3 py-2 text-sm text-center text-gray-200 border border-gray-600 rounded hover:bg-gray-700"
									>
										Download Screenshot
									</a>
									{referenceUrl && (
										<a
											href={referenceUrl}
											download={`${testName}_reference.png`}
											className="block w-full px-3 py-2 text-sm text-center text-gray-200 border border-gray-600 rounded hover:bg-gray-700"
										>
											Download Reference
										</a>
									)}
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>

			{/* Backdrop click to close */}
			<div
				className="absolute inset-0 -z-10"
				onClick={onClose}
			/>
		</div>
	);
}
