import { promises as fs } from 'fs';
import path from 'path';
import type { ReferenceInfo, ReferenceManifest } from '@banshee-forge/shared';
import { DEFAULT_SNAPSHOT_CATEGORY } from '@banshee-forge/shared';
import { JsonFileStorage } from '../storage/json-file.js';

/**
 * Repository for managing reference (baseline) images for snapshot comparison.
 *
 * Storage structure:
 * data/references/{projectSlug}/{configurationId}/{platform}/
 * ├── manifest.json       # { "{category}/{testName}": ReferenceInfo }
 * ├── Vulkan/
 * │   ├── Lighting.png
 * │   └── ...
 * └── D3D12/
 *     └── ...
 *
 * References are scoped per target platform because the same category (e.g. Vulkan) renders
 * differently on Windows and macOS. Pre-platform layouts are moved under DEFAULT_PLATFORM by the
 * startup migration. Manifests written before categories existed are keyed by bare testName
 * with images stored flat; getManifest() lazily migrates them to the categorized layout under
 * DEFAULT_SNAPSHOT_CATEGORY.
 */
export class ReferenceRepository {
	constructor(
		private storage: JsonFileStorage,
		private basePath: string
	) {}

	private scopeDir(projectSlug: string, configurationId: string, platform: string): string {
		return `references/${projectSlug}/${configurationId}/${platform}`;
	}

	private manifestPath(projectSlug: string, configurationId: string, platform: string): string {
		return `${this.scopeDir(projectSlug, configurationId, platform)}/manifest.json`;
	}

	private imagePath(projectSlug: string, configurationId: string, platform: string, category: string, testName: string): string {
		return `${this.scopeDir(projectSlug, configurationId, platform)}/${category}/${testName}.png`;
	}

	private manifestKey(category: string, testName: string): string {
		return `${category}/${testName}`;
	}

	/**
	 * Get the manifest for a project/configuration, migrating legacy (pre-category)
	 * manifests to the categorized layout on first access.
	 */
	async getManifest(projectSlug: string, configurationId: string, platform: string): Promise<ReferenceManifest> {
		const manifest = await this.storage.read<ReferenceManifest>(
			this.manifestPath(projectSlug, configurationId, platform),
			{ references: {} }
		);

		const hasLegacyKeys = Object.keys(manifest.references).some(key => !key.includes('/'));
		if (!hasLegacyKeys) return manifest;

		return this.migrateLegacyManifest(projectSlug, configurationId, platform, manifest);
	}

	/**
	 * Move flat-layout reference images into the default category directory and rewrite
	 * manifest entries under "{category}/{testName}" keys.
	 */
	private async migrateLegacyManifest(
		projectSlug: string,
		configurationId: string,
		platform: string,
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
				`${this.scopeDir(projectSlug, configurationId, platform)}/${testName}.png`
			);
			const newImagePath = path.join(
				this.basePath,
				this.imagePath(projectSlug, configurationId, platform, category, testName)
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
				platform,
				path: `${category}/${testName}.png`,
			};
		}

		await this.storage.write(this.manifestPath(projectSlug, configurationId, platform), migrated);
		return migrated;
	}

	/**
	 * Get reference info for a specific test
	 */
	async getReferenceInfo(
		projectSlug: string,
		configurationId: string,
		platform: string,
		category: string,
		testName: string
	): Promise<ReferenceInfo | null> {
		const manifest = await this.getManifest(projectSlug, configurationId, platform);
		return manifest.references[this.manifestKey(category, testName)] ?? null;
	}

	/**
	 * Check if a reference exists for a test. Reads the manifest first so legacy
	 * layouts are migrated before the image file is checked.
	 */
	async hasReference(
		projectSlug: string,
		configurationId: string,
		platform: string,
		category: string,
		testName: string
	): Promise<boolean> {
		await this.getManifest(projectSlug, configurationId, platform);
		return this.storage.exists(this.imagePath(projectSlug, configurationId, platform, category, testName));
	}

	/**
	 * Get the full filesystem path to a reference image
	 */
	getReferenceImagePath(
		projectSlug: string,
		configurationId: string,
		platform: string,
		category: string,
		testName: string
	): string {
		return path.join(this.basePath, this.imagePath(projectSlug, configurationId, platform, category, testName));
	}

	/**
	 * Set a screenshot from a build as the new reference
	 */
	async setReference(
		projectSlug: string,
		configurationId: string,
		platform: string,
		category: string,
		testName: string,
		screenshotPath: string,
		buildId: string
	): Promise<ReferenceInfo> {
		// Read (and if needed migrate) the manifest before writing the new image
		const manifest = await this.getManifest(projectSlug, configurationId, platform);

		// Copy the screenshot to reference storage
		const destPath = path.join(this.basePath, this.imagePath(projectSlug, configurationId, platform, category, testName));
		await fs.mkdir(path.dirname(destPath), { recursive: true });
		await fs.copyFile(screenshotPath, destPath);

		const info: ReferenceInfo = {
			testName,
			category,
			platform,
			path: `${category}/${testName}.png`,
			updatedAt: new Date().toISOString(),
			buildId,
			configurationId,
		};
		manifest.references[this.manifestKey(category, testName)] = info;
		await this.storage.write(this.manifestPath(projectSlug, configurationId, platform), manifest);

		return info;
	}

	/**
	 * Delete a reference image
	 */
	async deleteReference(
		projectSlug: string,
		configurationId: string,
		platform: string,
		category: string,
		testName: string
	): Promise<boolean> {
		// Check if reference exists (also migrates legacy layouts)
		const exists = await this.hasReference(projectSlug, configurationId, platform, category, testName);
		if (!exists) return false;

		// Delete the image file
		await this.storage.delete(this.imagePath(projectSlug, configurationId, platform, category, testName));

		// Update manifest
		const manifest = await this.getManifest(projectSlug, configurationId, platform);
		delete manifest.references[this.manifestKey(category, testName)];
		await this.storage.write(this.manifestPath(projectSlug, configurationId, platform), manifest);

		return true;
	}

	/**
	 * List all references for a project, keyed by "{configurationId}/{platform}".
	 */
	async listReferences(projectSlug: string): Promise<Record<string, ReferenceManifest>> {
		const result: Record<string, ReferenceManifest> = {};

		const refsDir = path.join(this.basePath, 'references', projectSlug);
		let configEntries: import('fs').Dirent[];
		try {
			configEntries = await fs.readdir(refsDir, { withFileTypes: true });
		} catch {
			return result; // Directory doesn't exist
		}

		for (const configEntry of configEntries) {
			if (!configEntry.isDirectory()) continue;
			const configId = configEntry.name;
			let platformEntries: import('fs').Dirent[];
			try {
				platformEntries = await fs.readdir(path.join(refsDir, configId), { withFileTypes: true });
			} catch {
				continue;
			}
			for (const platformEntry of platformEntries) {
				if (!platformEntry.isDirectory()) continue;
				const platform = platformEntry.name;
				result[`${configId}/${platform}`] = await this.getManifest(projectSlug, configId, platform);
			}
		}

		return result;
	}

	/**
	 * List all references for a specific configuration and platform
	 */
	async listConfigurationReferences(
		projectSlug: string,
		configurationId: string,
		platform: string
	): Promise<ReferenceInfo[]> {
		const manifest = await this.getManifest(projectSlug, configurationId, platform);
		return Object.values(manifest.references);
	}

	/**
	 * Copy all references from one configuration to another, within the same platform
	 */
	async copyReferences(
		projectSlug: string,
		platform: string,
		sourceConfigId: string,
		destConfigId: string
	): Promise<number> {
		const sourceManifest = await this.getManifest(projectSlug, sourceConfigId, platform);
		const destManifest = await this.getManifest(projectSlug, destConfigId, platform);
		let count = 0;

		for (const [key, info] of Object.entries(sourceManifest.references)) {
			const sourcePath = this.getReferenceImagePath(projectSlug, sourceConfigId, platform, info.category, info.testName);
			const destPath = path.join(
				this.basePath,
				this.imagePath(projectSlug, destConfigId, platform, info.category, info.testName)
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
			await this.storage.write(this.manifestPath(projectSlug, destConfigId, platform), destManifest);
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
		platform: string,
		sourceCategory: string,
		destCategory: string
	): Promise<number> {
		const manifest = await this.getManifest(projectSlug, configurationId, platform);
		let count = 0;

		const sourceEntries = Object.values(manifest.references).filter(
			info => info.category === sourceCategory
		);

		for (const info of sourceEntries) {
			const sourcePath = this.getReferenceImagePath(projectSlug, configurationId, platform, sourceCategory, info.testName);
			const destPath = path.join(
				this.basePath,
				this.imagePath(projectSlug, configurationId, platform, destCategory, info.testName)
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
			await this.storage.write(this.manifestPath(projectSlug, configurationId, platform), manifest);
		}

		return count;
	}
}
