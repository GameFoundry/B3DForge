import { promises as fs } from 'fs';
import path from 'path';
import { JsonFileStorage } from '../storage/json-file.js';

export interface ReferenceInfo {
	testName: string;
	path: string;
	updatedAt: string;
	buildId: string;
	configurationId: string;
}

export interface ReferenceManifest {
	references: Record<string, ReferenceInfo>;
}

/**
 * Repository for managing reference (baseline) images for snapshot comparison.
 *
 * Storage structure:
 * data/references/{projectSlug}/{configurationId}/
 * ├── manifest.json       # { testName: { path, updatedAt, buildId } }
 * ├── ExampleLighting.png
 * ├── ExamplePhysics.png
 * └── ...
 */
export class ReferenceRepository {
	constructor(
		private storage: JsonFileStorage,
		private basePath: string
	) {}

	private manifestPath(projectSlug: string, configurationId: string): string {
		return `references/${projectSlug}/${configurationId}/manifest.json`;
	}

	private imagePath(projectSlug: string, configurationId: string, testName: string): string {
		return `references/${projectSlug}/${configurationId}/${testName}.png`;
	}

	/**
	 * Get the manifest for a project/configuration
	 */
	async getManifest(projectSlug: string, configurationId: string): Promise<ReferenceManifest> {
		return this.storage.read<ReferenceManifest>(
			this.manifestPath(projectSlug, configurationId),
			{ references: {} }
		);
	}

	/**
	 * Get reference info for a specific test
	 */
	async getReferenceInfo(
		projectSlug: string,
		configurationId: string,
		testName: string
	): Promise<ReferenceInfo | null> {
		const manifest = await this.getManifest(projectSlug, configurationId);
		return manifest.references[testName] ?? null;
	}

	/**
	 * Check if a reference exists for a test
	 */
	async hasReference(projectSlug: string, configurationId: string, testName: string): Promise<boolean> {
		return this.storage.exists(this.imagePath(projectSlug, configurationId, testName));
	}

	/**
	 * Get the full filesystem path to a reference image
	 */
	getReferenceImagePath(projectSlug: string, configurationId: string, testName: string): string {
		return path.join(this.basePath, this.imagePath(projectSlug, configurationId, testName));
	}

	/**
	 * Set a screenshot from a build as the new reference
	 */
	async setReference(
		projectSlug: string,
		configurationId: string,
		testName: string,
		screenshotPath: string,
		buildId: string
	): Promise<ReferenceInfo> {
		// Copy the screenshot to reference storage
		const destPath = path.join(this.basePath, this.imagePath(projectSlug, configurationId, testName));
		await fs.mkdir(path.dirname(destPath), { recursive: true });
		await fs.copyFile(screenshotPath, destPath);

		// Update manifest
		const manifest = await this.getManifest(projectSlug, configurationId);
		const info: ReferenceInfo = {
			testName,
			path: `${testName}.png`,
			updatedAt: new Date().toISOString(),
			buildId,
			configurationId,
		};
		manifest.references[testName] = info;
		await this.storage.write(this.manifestPath(projectSlug, configurationId), manifest);

		return info;
	}

	/**
	 * Delete a reference image
	 */
	async deleteReference(projectSlug: string, configurationId: string, testName: string): Promise<boolean> {
		// Check if reference exists
		const exists = await this.hasReference(projectSlug, configurationId, testName);
		if (!exists) return false;

		// Delete the image file
		await this.storage.delete(this.imagePath(projectSlug, configurationId, testName));

		// Update manifest
		const manifest = await this.getManifest(projectSlug, configurationId);
		delete manifest.references[testName];
		await this.storage.write(this.manifestPath(projectSlug, configurationId), manifest);

		return true;
	}

	/**
	 * List all references for a project
	 */
	async listReferences(projectSlug: string): Promise<Record<string, ReferenceManifest>> {
		const result: Record<string, ReferenceManifest> = {};

		// Get all configuration directories
		const refsDir = path.join(this.basePath, 'references', projectSlug);
		try {
			const entries = await fs.readdir(refsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const configId = entry.name;
					result[configId] = await this.getManifest(projectSlug, configId);
				}
			}
		} catch {
			// Directory doesn't exist, return empty
		}

		return result;
	}

	/**
	 * List all references for a specific configuration
	 */
	async listConfigurationReferences(
		projectSlug: string,
		configurationId: string
	): Promise<ReferenceInfo[]> {
		const manifest = await this.getManifest(projectSlug, configurationId);
		return Object.values(manifest.references);
	}

	/**
	 * Copy all references from one configuration to another
	 */
	async copyReferences(
		projectSlug: string,
		sourceConfigId: string,
		destConfigId: string
	): Promise<number> {
		const sourceManifest = await this.getManifest(projectSlug, sourceConfigId);
		let count = 0;

		for (const [testName, info] of Object.entries(sourceManifest.references)) {
			const sourcePath = this.getReferenceImagePath(projectSlug, sourceConfigId, testName);
			const destPath = path.join(this.basePath, this.imagePath(projectSlug, destConfigId, testName));

			try {
				await fs.mkdir(path.dirname(destPath), { recursive: true });
				await fs.copyFile(sourcePath, destPath);

				// Update dest manifest
				const destManifest = await this.getManifest(projectSlug, destConfigId);
				destManifest.references[testName] = {
					...info,
					configurationId: destConfigId,
					updatedAt: new Date().toISOString(),
				};
				await this.storage.write(this.manifestPath(projectSlug, destConfigId), destManifest);

				count++;
			} catch {
				// Skip failed copies
			}
		}

		return count;
	}
}
