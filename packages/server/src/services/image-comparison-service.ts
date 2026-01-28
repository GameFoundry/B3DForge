import { promises as fs } from 'fs';
import path from 'path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface ComparisonResult {
	match: boolean;
	diffPixels: number;
	totalPixels: number;
	diffPercentage: number;
	diffImagePath?: string;
	error?: string;
}

export interface ComparisonOptions {
	/** Matching threshold (0 to 1). Smaller values make the comparison more sensitive. Default: 0.1 */
	threshold?: number;
	/** If true, disables anti-aliasing detection. Default: false */
	includeAA?: boolean;
	/** Color of differing pixels [R, G, B]. Default: [255, 0, 255] (magenta) */
	diffColor?: [number, number, number];
}

const DEFAULT_OPTIONS: ComparisonOptions = {
	threshold: 0.1,
	includeAA: false,
	diffColor: [255, 0, 255],
};

/**
 * Service for comparing images and generating visual diffs.
 * Uses pixelmatch for pixel-level comparison.
 */
export class ImageComparisonService {
	/**
	 * Compare two images and return the comparison result.
	 * If outputPath is provided, generates a diff image.
	 */
	async compareImages(
		currentPath: string,
		referencePath: string,
		outputPath?: string,
		options: ComparisonOptions = {}
	): Promise<ComparisonResult> {
		const opts = { ...DEFAULT_OPTIONS, ...options };

		try {
			// Read images
			const [currentBuffer, referenceBuffer] = await Promise.all([
				fs.readFile(currentPath),
				fs.readFile(referencePath),
			]);

			const current = PNG.sync.read(currentBuffer);
			const reference = PNG.sync.read(referenceBuffer);

			// Check dimensions match
			if (current.width !== reference.width || current.height !== reference.height) {
				return {
					match: false,
					diffPixels: -1,
					totalPixels: current.width * current.height,
					diffPercentage: 100,
					error: `Image dimensions don't match: current (${current.width}x${current.height}) vs reference (${reference.width}x${reference.height})`,
				};
			}

			const totalPixels = current.width * current.height;

			// Create diff output buffer
			const diff = new PNG({ width: current.width, height: current.height });

			// Run comparison
			const diffPixels = pixelmatch(
				current.data,
				reference.data,
				diff.data,
				current.width,
				current.height,
				{
					threshold: opts.threshold,
					includeAA: opts.includeAA,
					diffColor: opts.diffColor,
				}
			);

			const diffPercentage = (diffPixels / totalPixels) * 100;
			const match = diffPixels === 0;

			// Save diff image if requested
			let diffImagePath: string | undefined;
			if (outputPath) {
				await fs.mkdir(path.dirname(outputPath), { recursive: true });
				await fs.writeFile(outputPath, PNG.sync.write(diff));
				diffImagePath = outputPath;
			}

			return {
				match,
				diffPixels,
				totalPixels,
				diffPercentage,
				diffImagePath,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return {
				match: false,
				diffPixels: -1,
				totalPixels: 0,
				diffPercentage: 100,
				error: `Comparison failed: ${message}`,
			};
		}
	}

	/**
	 * Generate a diff image between current and reference images.
	 * Returns the path to the generated diff image.
	 */
	async generateDiffImage(
		currentPath: string,
		referencePath: string,
		outputPath: string,
		options: ComparisonOptions = {}
	): Promise<string> {
		const result = await this.compareImages(currentPath, referencePath, outputPath, options);

		if (result.error) {
			throw new Error(result.error);
		}

		return result.diffImagePath!;
	}

	/**
	 * Quick check if two images are identical (no diff generation).
	 */
	async imagesMatch(
		currentPath: string,
		referencePath: string,
		threshold = 0.1
	): Promise<boolean> {
		const result = await this.compareImages(currentPath, referencePath, undefined, { threshold });
		return result.match;
	}

	/**
	 * Get the diff percentage between two images.
	 */
	async getDiffPercentage(
		currentPath: string,
		referencePath: string,
		threshold = 0.1
	): Promise<number> {
		const result = await this.compareImages(currentPath, referencePath, undefined, { threshold });
		return result.diffPercentage;
	}
}
