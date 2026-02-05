import { useState, useRef, useEffect, useCallback } from 'react';

type ViewMode = 'slider' | 'side-by-side' | 'diff' | 'log';

interface ImageComparisonViewerProps {
	currentUrl: string;
	referenceUrl?: string;
	diffUrl?: string;
	diffPercentage?: number;
	log?: string;
	logLoading?: boolean;
	defaultMode?: ViewMode;
	onModeChange?: (mode: ViewMode) => void;
}

export function ImageComparisonViewer({
	currentUrl,
	referenceUrl,
	diffUrl,
	diffPercentage,
	log,
	logLoading,
	defaultMode,
	onModeChange,
}: ImageComparisonViewerProps) {
	const [mode, setMode] = useState<ViewMode>(defaultMode ?? 'slider');
	const [sliderPosition, setSliderPosition] = useState(50);
	const [zoom, setZoom] = useState(1);
	const [pan, setPan] = useState({ x: 0, y: 0 });
	const [isDragging, setIsDragging] = useState(false);
	const [isSliding, setIsSliding] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const startPanRef = useRef({ x: 0, y: 0 });
	const startMouseRef = useRef({ x: 0, y: 0 });

	const hasReference = !!referenceUrl;
	const hasDiff = !!diffUrl;

	const handleModeChange = (newMode: ViewMode) => {
		setMode(newMode);
		onModeChange?.(newMode);
	};

	const handleZoom = (delta: number) => {
		setZoom(prev => Math.max(0.25, Math.min(4, prev + delta)));
	};

	const handleReset = () => {
		setZoom(1);
		setPan({ x: 0, y: 0 });
	};

	// Mouse handlers for panning and sliding
	const handleMouseDown = useCallback((e: React.MouseEvent) => {
		if (mode === 'slider' && e.target === e.currentTarget) {
			// Start sliding
			setIsSliding(true);
			const rect = containerRef.current?.getBoundingClientRect();
			if (rect) {
				const x = e.clientX - rect.left;
				setSliderPosition((x / rect.width) * 100);
			}
		} else {
			// Start panning
			setIsDragging(true);
			startPanRef.current = pan;
			startMouseRef.current = { x: e.clientX, y: e.clientY };
		}
	}, [mode, pan]);

	const handleMouseMove = useCallback((e: React.MouseEvent) => {
		if (isSliding) {
			const rect = containerRef.current?.getBoundingClientRect();
			if (rect) {
				const x = e.clientX - rect.left;
				setSliderPosition(Math.max(0, Math.min(100, (x / rect.width) * 100)));
			}
		} else if (isDragging) {
			const dx = e.clientX - startMouseRef.current.x;
			const dy = e.clientY - startMouseRef.current.y;
			setPan({
				x: startPanRef.current.x + dx,
				y: startPanRef.current.y + dy,
			});
		}
	}, [isDragging, isSliding]);

	const handleMouseUp = useCallback(() => {
		setIsDragging(false);
		setIsSliding(false);
	}, []);

	// Keyboard shortcuts
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === '1') handleModeChange('slider');
			else if (e.key === '2') handleModeChange('side-by-side');
			else if (e.key === '3' && hasDiff) handleModeChange('diff');
			else if (e.key === '4') handleModeChange('log');
			else if (e.key === '+' || e.key === '=') handleZoom(0.25);
			else if (e.key === '-') handleZoom(-0.25);
			else if (e.key === '0') handleReset();
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [hasDiff]);

	const imageStyle = {
		transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
		cursor: isDragging ? 'grabbing' : 'grab',
	};

	return (
		<div className="flex flex-col h-full">
			{/* Toolbar */}
			<div className="flex items-center justify-between p-2 bg-gray-800 border-b border-gray-700">
				<div className="flex items-center gap-2">
					{/* Mode Selector */}
					<div className="flex border border-gray-600 rounded-md overflow-hidden">
						<button
							onClick={() => handleModeChange('slider')}
							className={`px-3 py-1.5 text-sm ${mode === 'slider' ? 'bg-blue-900/50 text-blue-300' : 'text-gray-400 hover:bg-gray-700'}`}
							disabled={!hasReference}
							title="Slider comparison (1)"
						>
							Slider
						</button>
						<button
							onClick={() => handleModeChange('side-by-side')}
							className={`px-3 py-1.5 text-sm border-l border-gray-600 ${mode === 'side-by-side' ? 'bg-blue-900/50 text-blue-300' : 'text-gray-400 hover:bg-gray-700'}`}
							disabled={!hasReference}
							title="Side-by-side (2)"
						>
							Side-by-Side
						</button>
						{hasDiff && (
							<button
								onClick={() => handleModeChange('diff')}
								className={`px-3 py-1.5 text-sm border-l border-gray-600 ${mode === 'diff' ? 'bg-blue-900/50 text-blue-300' : 'text-gray-400 hover:bg-gray-700'}`}
								title="Diff overlay (3)"
							>
								Diff
							</button>
						)}
					</div>

					{/* Log Button - separate from image modes */}
					<button
						onClick={() => handleModeChange('log')}
						className={`px-3 py-1.5 text-sm border border-gray-600 rounded-md ${mode === 'log' ? 'bg-blue-900/50 text-blue-300' : 'text-gray-400 hover:bg-gray-700'}`}
						title="Console output (4)"
					>
						Log
					</button>

					{diffPercentage !== undefined && (
						<span className={`px-2 py-1 text-sm rounded ${
							diffPercentage === 0 ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'
						}`}>
							{diffPercentage === 0 ? 'Identical' : `${diffPercentage.toFixed(2)}% difference`}
						</span>
					)}
				</div>

				{/* Zoom Controls */}
				<div className="flex items-center gap-2">
					<button
						onClick={() => handleZoom(-0.25)}
						className="px-2 py-1 text-sm border border-gray-600 rounded text-gray-300 hover:bg-gray-700"
						title="Zoom out (-)"
					>
						−
					</button>
					<span className="text-sm text-gray-400 w-16 text-center">
						{Math.round(zoom * 100)}%
					</span>
					<button
						onClick={() => handleZoom(0.25)}
						className="px-2 py-1 text-sm border border-gray-600 rounded text-gray-300 hover:bg-gray-700"
						title="Zoom in (+)"
					>
						+
					</button>
					<button
						onClick={handleReset}
						className="px-3 py-1 text-sm border border-gray-600 rounded text-gray-300 hover:bg-gray-700"
						title="Reset (0)"
					>
						Reset
					</button>
				</div>
			</div>

			{/* Comparison View */}
			<div
				ref={containerRef}
				className="flex-1 overflow-hidden bg-gray-800 relative"
				onMouseDown={handleMouseDown}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
				onMouseLeave={handleMouseUp}
			>
				{mode === 'log' ? (
					<LogView log={log} logLoading={logLoading} />
				) : mode === 'slider' && hasReference ? (
					<SliderView
						currentUrl={currentUrl}
						referenceUrl={referenceUrl!}
						sliderPosition={sliderPosition}
						imageStyle={imageStyle}
					/>
				) : mode === 'side-by-side' && hasReference ? (
					<SideBySideView
						currentUrl={currentUrl}
						referenceUrl={referenceUrl!}
						imageStyle={imageStyle}
					/>
				) : mode === 'diff' && hasDiff ? (
					<DiffView
						currentUrl={currentUrl}
						diffUrl={diffUrl!}
						imageStyle={imageStyle}
					/>
				) : (
					<SingleImageView
						url={currentUrl}
						imageStyle={imageStyle}
					/>
				)}

				{/* Slider handle */}
				{mode === 'slider' && hasReference && (
					<div
						className="absolute top-0 bottom-0 w-1 bg-white shadow-lg cursor-ew-resize z-10"
						style={{ left: `${sliderPosition}%`, transform: 'translateX(-50%)' }}
						onMouseDown={(e) => {
							e.stopPropagation();
							setIsSliding(true);
						}}
					>
						<div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center">
							<span className="text-gray-500 text-sm">⟷</span>
						</div>
					</div>
				)}
			</div>

			{/* Help text */}
			<div className="p-2 bg-gray-800 text-xs text-gray-500 border-t border-gray-700">
				Drag to pan · Scroll or +/- to zoom · Keys 1-4 to switch modes
			</div>
		</div>
	);
}

function SliderView({
	currentUrl,
	referenceUrl,
	sliderPosition,
	imageStyle,
}: {
	currentUrl: string;
	referenceUrl: string;
	sliderPosition: number;
	imageStyle: React.CSSProperties;
}) {
	return (
		<div className="relative w-full h-full flex items-center justify-center">
			{/* Reference (full, underneath) */}
			<div className="absolute inset-0 flex items-center justify-center overflow-hidden">
				<img
					src={referenceUrl}
					alt="Reference"
					className="max-w-full max-h-full object-contain select-none"
					style={imageStyle}
					draggable={false}
				/>
			</div>

			{/* Current (clipped) */}
			<div
				className="absolute inset-0 flex items-center justify-center overflow-hidden"
				style={{ clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }}
			>
				<img
					src={currentUrl}
					alt="Current"
					className="max-w-full max-h-full object-contain select-none"
					style={imageStyle}
					draggable={false}
				/>
			</div>

			{/* Labels */}
			<div className="absolute bottom-4 left-4 px-2 py-1 bg-black/70 text-white text-xs rounded">
				Current
			</div>
			<div className="absolute bottom-4 right-4 px-2 py-1 bg-black/70 text-white text-xs rounded">
				Reference
			</div>
		</div>
	);
}

function SideBySideView({
	currentUrl,
	referenceUrl,
	imageStyle,
}: {
	currentUrl: string;
	referenceUrl: string;
	imageStyle: React.CSSProperties;
}) {
	return (
		<div className="flex w-full h-full">
			<div className="flex-1 flex flex-col items-center justify-center p-2 border-r border-gray-600">
				<div className="text-white text-sm mb-2">Current</div>
				<img
					src={currentUrl}
					alt="Current"
					className="max-w-full max-h-full object-contain select-none"
					style={imageStyle}
					draggable={false}
				/>
			</div>
			<div className="flex-1 flex flex-col items-center justify-center p-2">
				<div className="text-white text-sm mb-2">Reference</div>
				<img
					src={referenceUrl}
					alt="Reference"
					className="max-w-full max-h-full object-contain select-none"
					style={imageStyle}
					draggable={false}
				/>
			</div>
		</div>
	);
}

function DiffView({
	currentUrl,
	diffUrl,
	imageStyle,
}: {
	currentUrl: string;
	diffUrl: string;
	imageStyle: React.CSSProperties;
}) {
	const [showDiff, setShowDiff] = useState(true);

	return (
		<div className="relative w-full h-full flex items-center justify-center">
			{/* Current image */}
			<img
				src={currentUrl}
				alt="Current"
				className="max-w-full max-h-full object-contain select-none"
				style={imageStyle}
				draggable={false}
			/>

			{/* Diff overlay */}
			{showDiff && (
				<img
					src={diffUrl}
					alt="Diff"
					className="absolute max-w-full max-h-full object-contain select-none mix-blend-multiply"
					style={imageStyle}
					draggable={false}
				/>
			)}

			{/* Toggle button */}
			<button
				onClick={() => setShowDiff(!showDiff)}
				className="absolute bottom-4 left-4 px-3 py-1.5 bg-black/70 text-white text-sm rounded hover:bg-black/80"
			>
				{showDiff ? 'Hide Diff' : 'Show Diff'}
			</button>
		</div>
	);
}

function SingleImageView({
	url,
	imageStyle,
}: {
	url: string;
	imageStyle: React.CSSProperties;
}) {
	return (
		<div className="relative w-full h-full flex items-center justify-center">
			<img
				src={url}
				alt="Screenshot"
				className="max-w-full max-h-full object-contain select-none"
				style={imageStyle}
				draggable={false}
			/>
			<div className="absolute bottom-4 left-4 px-2 py-1 bg-black/70 text-white text-xs rounded">
				No reference image available
			</div>
		</div>
	);
}

function LogView({
	log,
	logLoading,
}: {
	log?: string;
	logLoading?: boolean;
}) {
	return (
		<div className="w-full h-full overflow-auto p-4 bg-gray-900">
			{logLoading ? (
				<div className="flex items-center justify-center h-full text-gray-500">
					Loading console output...
				</div>
			) : log ? (
				<pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap break-words">
					{log}
				</pre>
			) : (
				<div className="flex items-center justify-center h-full text-gray-500">
					No console output available
				</div>
			)}
		</div>
	);
}
