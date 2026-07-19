import { promises as fs } from 'fs';
import path from 'path';
import type { ReferenceInfo, ReferenceManifest } from '@banshee-forge/shared';
import { DEFAULT_SNAPSHOT_CATEGORY } from '@banshee-forge/shared';
import { JsonFileStorage } from '../storage/json-file.js';

/**
 * Repository for managing reference (baseline) images for snapshot comparison.
 *
 * Storage structure:
 * data/references/{projectSlug}/{configurationId}/
 * ├── manifest.json       # { "{category}/{testName}": ReferenceInfo }
 * ├── Vulkan/
 * │   ├── Lighting.png
 * │   └── ...
 * └── D3D12/
 *     └── ...
 *
 * Manifests written before categories existed are keyed by bare testName with images
 * stored flat; getManifest() lazily migrates them to the categorized layout under
 * DEFAULT_SNAPSHOT_CATEGORY.
 */
export class ReferenceRepository {
	constructor(
		private storage: JsonFileStorage,
		private basePath: string
	) {}

	private manifestPath(projectSlug: string, configurationId: string): string {
		return `references/${projectSlug}/${configurationId}/manifest.json`;
	}

	private imagePath(projectSlug: string, configurationId: string, category: string, testName: string): string {
		return `references/${projectSlug}/${configurationId}/${category}/${testName}.png`;
	}

	private manifestKey(category: string, testName: string): string {
		return `${category}/${testName}`;
	}

	/**
	 * Get the manifest for a project/configuration, migrating legacy (pre-category)
	 * manifests to the categorized layout on first access.
	 */
	async getManifest(projectSlug: string, configurationId: string): Promise<ReferenceManifest> {
		const manifest = await this.storage.read<ReferenceManifest>(
			this.manifestPath(projectSlug, configurationId),
			{ references: {} }
		);

		const hasLegacyKeys = Object.keys(manifest.references).some(key => !key.includes('/'));
		if (!hasLegacyKeys) return manifest;

		return this.migrateLegacyManifest(projectSlug, configurationId, manifest);
	}

	/**
	 * Move flat-layout reference images into the default category directory and rewrite
	 * manifest entries under "{category}/{testName}" keys.
	 */
	private async migrateLegacyManifest(
		projectSlug: string,
		configurationId: string,
		manifest: ReferenceManifest
	): Promise<ReferenceManifest> {
		const migrated: ReferenceManifest = { references: {} };

		for (const [key, info] of Object.entries(manifest.references)) {
			if (key.includes('/')) {
				migrated.references[key] = info;
				continue;
			}

			const testName = info.testName || key;
			const category = DEFAULT_SNAPSHOT_CATEGORY;

			const oldImagePath = path.join(
				this.basePath,
				`references/${projectSlug}/${configurationId}/${testName}.png`
			);
			const newImagePath = path.join(
				this.basePath,
				this.imagePath(projectSlug, configurationId, category, testName)
			);

			try {
				await fs.mkdir(path.dirname(newImagePath), { recursive: true });
				await fs.rename(oldImagePath, newImagePath);
			} catch {
				// Image already moved or never existed; keep the manifest entry either way
			}

			migrated.references[this.manifestKey(category, testName)] = {
				...info,
				testName,
				category,
				path: `${category}/${testName}.png`,
			};
		}

		await this.storage.write(this.manifestPath(projectSlug, configurationId), migrated);
		return migrated;
	}

	/**
	 * Get reference info for a specific test
	 */
	async getReferenceInfo(
		projectSlug: string,
		configurationId: string,
		category: string,
		testName: string
	): Promise<ReferenceInfo | null> {
		const manifest = await this.getManifest(projectSlug, configurationId);
		return manifest.references[this.manifestKey(category, testName)] ?? null;
	}

	/**
	 * Check if a reference exists for a test. Reads the manifest first so legacy
	 * layouts are migrated before the image file is checked.
	 */
	async hasReference(
		projectSlug: string,
		configurationId: string,
		category: string,
		testName: string
	): Promise<boolean> {
		await this.getManifest(projectSlug, configurationId);
		return this.storage.exists(this.imagePath(projectSlug, configurationId, category, testName));
	}

	/**
	 * Get the full filesystem path to a reference image
	 */
	getReferenceImagePath(
		projectSlug: string,
		configurationId: string,
		category: string,
		testName: string
	): string {
		return path.join(this.basePath, this.imagePath(projectSlug, configurationId, category, testName));
	}

	/**
	 * Set a screenshot from a build as the new reference
	 */
	async setReference(
		projectSlug: string,
		configurationId: string,
		category: string,
		testName: string,
		screenshotPath: string,
		buildId: string
	): Promise<ReferenceInfo> {
		// Read (and if needed migrate) the manifest before writing the new image
		const manifest = await this.getManifest(projectSlug, configurationId);

		// Copy the screenshot to reference storage
		const destPath = path.join(this.basePath, this.imagePath(projectSlug, configurationId, category, testName));
		await fs.mkdir(path.dirname(destPath), { recursive: true });
		await fs.copyFile(screenshotPath, destPath);

		const info: ReferenceInfo = {
			testName,
			category,
			path: `${category}/${testName}.png`,
			updatedAt: new Date().toISOString(),
			buildId,
			configurationId,
		};
		manifest.references[this.manifestKey(category, testName)] = info;
		await this.storage.write(this.manifestPath(projectSlug, configurationId), manifest);

		return info;
	}

	/**
	 * Delete a reference image
	 */
	async deleteReference(
		projectSlug: string,
		configurationId: string,
		category: string,
		testName: string
	): Promise<boolean> {
		// Check if reference exists (also migrates legacy layouts)
		const exists = await this.hasReference(projectSlug, configurationId, category, testName);
		if (!exists) return false;

		// Delete the image file
		await this.storage.delete(this.imagePath(projectSlug, configurationId, category, testName));

		// Update manifest
		const manifest = await this.getManifest(projectSlug, configurationId);
		delete manifest.references[this.manifestKey(category, testName)];
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
		const destManifest = await this.getManifest(projectSlug, destConfigId);
		let count = 0;

		for (const [key, info] of Object.entries(sourceManifest.references)) {
			const sourcePath = this.getReferenceImagePath(projectSlug, sourceConfigId, info.category, info.testName);
			const destPath = path.join(
				this.basePath,
				this.imagePath(projectSlug, destConfigId, info.category, info.testName)
			);

			try {
				await fs.mkdir(path.dirname(destPath), { recursive: true });
				await fs.copyFile(sourcePath, destPath);

				destManifest.references[key] = {
					...info,
					configurationId: destConfigId,
					updatedAt: new Date().toISOString(),
				};

				count++;
			} catch {
				// Skip failed copies
			}
		}

		if (count > 0) {
			await this.storage.write(this.manifestPath(projectSlug, destConfigId), destManifest);
		}

		return count;
	}

	/**
	 * Copy all references from one category to another within the same configuration.
	 * Used to seed a new category's baselines (e.g. D3D12 from Vulkan).
	 */
	async copyCategoryReferences(
		projectSlug: string,
		configurationId: string,
		sourceCategory: string,
		destCategory: string
	): Promise<number> {
		const manifest = await this.getManifest(projectSlug, configurationId);
		let count = 0;

		const sourceEntries = Object.values(manifest.references).filter(
			info => info.category === sourceCategory
		);

		for (const info of sourceEntries) {
			const sourcePath = this.getReferenceImagePath(projectSlug, configurationId, sourceCategory, info.testName);
			const destPath = path.join(
				this.basePath,
				this.imagePath(projectSlug, configurationId, destCategory, info.testName)
			);

			try {
				await fs.mkdir(path.dirname(destPath), { recursive: true });
				await fs.copyFile(sourcePath, destPath);

				manifest.references[this.manifestKey(destCategory, info.testName)] = {
					...info,
					category: destCategory,
					path: `${destCategory}/${info.testName}.png`,
					updatedAt: new Date().toISOString(),
				};

				count++;
			} catch {
				// Skip failed copies
			}
		}

		if (count > 0) {
			await this.storage.write(this.manifestPath(projectSlug, configurationId), manifest);
		}

		return count;
	}
}
