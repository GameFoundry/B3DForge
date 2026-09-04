// Copyright (c) 2026 Marko Pintera. All rights reserved.

import fs from 'fs/promises';
import path from 'path';
import type { Project, BuildConfiguration, BuildSummary, Build, PollingTarget } from '@banshee-forge/shared';
import { DEFAULT_PLATFORM, PLATFORMS } from '@banshee-forge/shared';

interface ProjectsFile {
	projects: ProjectMigrating[];
}

/**
 * Project shape during migration. Allows the legacy fields we are about to drop
 * (`BuildConfiguration.autoBuild`, `BuildConfiguration.platform`,
 * `Project.pollingConfigurationIds`) alongside their replacements. Once written
 * back the file conforms to the canonical `Project` type.
 */
type ProjectMigrating = Omit<Project, 'configurations'> & {
	configurations: (BuildConfiguration & { autoBuild?: boolean; platform?: string })[];
	pollingConfigurationIds?: string[];
};

interface BuildsIndexFile {
	builds: (BuildSummary & { platform?: string })[];
	nextBuildNumber: number;
}

/**
 * One-time migrations that convert an existing data directory to the current
 * model. Each step is guarded so re-running on already-migrated data is a no-op.
 *
 *  - Promotes the default configuration's `fetch.sh` to a project-level
 *    `projects/{slug}/fetch.sh` (only if no project-level script already
 *    exists; per-config copies are left in place as a safety net).
 *  - Converts legacy `autoBuild` flags / `pollingConfigurationIds` into
 *    `Project.pollingTargets`, attributing existing entries to DEFAULT_PLATFORM.
 *  - Converts `BuildConfiguration.platform` ('any' | os) into `platforms[]`.
 *  - Stamps `platform = DEFAULT_PLATFORM` on builds recorded before per-platform
 *    builds existed (index and detail files).
 *  - Moves reference images from `references/{slug}/{configId}/{category}/` to
 *    `references/{slug}/{configId}/{DEFAULT_PLATFORM}/{category}/`.
 */
export async function runMigrations(dataPath: string): Promise<void> {
	await migrateProjects(dataPath);
	await migrateBuilds(dataPath);
	await migrateReferences(dataPath);
}

async function migrateProjects(dataPath: string): Promise<void> {
	const projectsFile = path.join(dataPath, 'projects', 'projects.json');

	let raw: string;
	try {
		raw = await fs.readFile(projectsFile, 'utf-8');
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return;
		throw err;
	}

	const data = JSON.parse(raw) as ProjectsFile;
	let mutated = false;

	for (const project of data.projects) {
		// 1. Promote the default config's fetch script to the project level.
		if (project.defaultConfigurationId) {
			const projectFetch = path.join(dataPath, 'projects', project.slug, 'fetch.sh');
			const projectExists = await pathExists(projectFetch);
			if (!projectExists) {
				const sourceFetch = path.join(
					dataPath,
					'projects',
					project.slug,
					'configs',
					project.defaultConfigurationId,
					'fetch.sh',
				);
				if (await pathExists(sourceFetch)) {
					await fs.mkdir(path.dirname(projectFetch), { recursive: true });
					await fs.copyFile(sourceFetch, projectFetch);
					console.log(`[migrate] Promoted ${project.slug}/configs/${project.defaultConfigurationId}/fetch.sh -> ${project.slug}/fetch.sh`);
				}
			}
		}

		// 2. Seed `pollingTargets` from `pollingConfigurationIds`, or before that
		//    from the legacy per-config `autoBuild` flags. Existing entries were
		//    only ever built on the default platform.
		if (project.pollingTargets === undefined) {
			let configIds: string[];
			if (project.pollingConfigurationIds !== undefined) {
				configIds = project.pollingConfigurationIds;
			} else {
				const fromAutoBuild = project.configurations
					.filter(c => c.autoBuild === true)
					.map(c => c.id);
				configIds = fromAutoBuild.length > 0
					? fromAutoBuild
					: project.defaultConfigurationId
						? [project.defaultConfigurationId]
						: [];
			}
			const targets: PollingTarget[] = configIds.map(configurationId => ({
				configurationId,
				platforms: [DEFAULT_PLATFORM],
			}));
			project.pollingTargets = targets;
			delete project.pollingConfigurationIds;
			mutated = true;
			console.log(`[migrate] ${project.slug}: pollingTargets = [${targets.map(t => `${t.configurationId}:${t.platforms.join('|')}`).join(', ')}]`);
		} else if (project.pollingConfigurationIds !== undefined) {
			delete project.pollingConfigurationIds;
			mutated = true;
		}

		// 3. Drop the obsolete per-config `autoBuild` field and convert the single
		//    `platform` restriction into a `platforms` list.
		for (const config of project.configurations) {
			if ('autoBuild' in config) {
				delete config.autoBuild;
				mutated = true;
			}
			if ('platform' in config) {
				const legacy = config.platform;
				if (config.platforms === undefined) {
					config.platforms = legacy && legacy !== 'any' && PLATFORMS.some(p => p.id === legacy)
						? [legacy]
						: [];
					console.log(`[migrate] ${project.slug}/${config.name}: platform '${legacy}' -> platforms [${config.platforms.join(', ')}]`);
				}
				delete config.platform;
				mutated = true;
			}
		}
	}

	if (mutated) {
		await writeJsonAtomic(projectsFile, data);
		console.log('[migrate] projects.json updated.');
	}
}

/** Stamp `platform` on every build index entry and detail file that predates per-platform builds. */
async function migrateBuilds(dataPath: string): Promise<void> {
	const buildsRoot = path.join(dataPath, 'builds');
	let projectDirs: string[];
	try {
		projectDirs = (await fs.readdir(buildsRoot, { withFileTypes: true }))
			.filter(e => e.isDirectory())
			.map(e => e.name);
	} catch {
		return;
	}

	for (const slug of projectDirs) {
		const indexPath = path.join(buildsRoot, slug, 'builds.json');
		let stamped = 0;

		try {
			const index = JSON.parse(await fs.readFile(indexPath, 'utf-8')) as BuildsIndexFile;
			let mutated = false;
			for (const summary of index.builds) {
				if (!summary.platform) {
					summary.platform = DEFAULT_PLATFORM;
					mutated = true;
				}
			}
			if (mutated) await writeJsonAtomic(indexPath, index);
		} catch {
			// No index (or unreadable): the orchestrator rebuilds it from detail files at startup.
		}

		let buildDirs: string[];
		try {
			buildDirs = (await fs.readdir(path.join(buildsRoot, slug), { withFileTypes: true }))
				.filter(e => e.isDirectory())
				.map(e => e.name);
		} catch {
			continue;
		}

		for (const buildId of buildDirs) {
			const detailPath = path.join(buildsRoot, slug, buildId, 'build.json');
			try {
				const build = JSON.parse(await fs.readFile(detailPath, 'utf-8')) as Build & { platform?: string };
				if (build.platform) continue;
				build.platform = DEFAULT_PLATFORM;
				await writeJsonAtomic(detailPath, build);
				stamped++;
			} catch {
				// Missing or corrupt detail file; leave it to index repair.
			}
		}

		if (stamped > 0) console.log(`[migrate] ${slug}: stamped platform '${DEFAULT_PLATFORM}' on ${stamped} build(s)`);
	}
}

/**
 * Move `references/{slug}/{configId}/{manifest.json, category dirs}` under a
 * `{DEFAULT_PLATFORM}` directory. A configuration directory is considered legacy
 * when it holds a `manifest.json` directly; migrated directories only contain
 * per-platform subdirectories.
 */
async function migrateReferences(dataPath: string): Promise<void> {
	const refsRoot = path.join(dataPath, 'references');
	let projectDirs: string[];
	try {
		projectDirs = (await fs.readdir(refsRoot, { withFileTypes: true }))
			.filter(e => e.isDirectory())
			.map(e => e.name);
	} catch {
		return;
	}

	for (const slug of projectDirs) {
		const projectDir = path.join(refsRoot, slug);
		const configDirs = (await fs.readdir(projectDir, { withFileTypes: true }))
			.filter(e => e.isDirectory())
			.map(e => e.name);

		for (const configId of configDirs) {
			const configDir = path.join(projectDir, configId);
			if (!(await pathExists(path.join(configDir, 'manifest.json')))) continue;

			const platformDir = path.join(configDir, DEFAULT_PLATFORM);
			await fs.mkdir(platformDir, { recursive: true });

			const entries = await fs.readdir(configDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name === DEFAULT_PLATFORM) continue;
				await fs.rename(path.join(configDir, entry.name), path.join(platformDir, entry.name));
			}
			console.log(`[migrate] references ${slug}/${configId} -> ${slug}/${configId}/${DEFAULT_PLATFORM}`);
		}
	}
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
	const tmp = filePath + '.tmp';
	await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
	await fs.rename(tmp, filePath);
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
