// Copyright (c) 2026 Marko Pintera. All rights reserved.

import fs from 'fs/promises';
import path from 'path';
import type { Project, BuildConfiguration } from '@banshee-forge/shared';

interface ProjectsFile {
	projects: ProjectMigrating[];
}

/**
 * Project shape during migration. Allows the legacy `BuildConfiguration.autoBuild`
 * field that we are about to drop, plus the new `pollingConfigurationIds` we are
 * adding. Once written back the file conforms to the canonical `Project` type.
 */
type ProjectMigrating = Omit<Project, 'configurations'> & {
	configurations: (BuildConfiguration & { autoBuild?: boolean })[];
};

/**
 * One-time migration that converts an existing data directory to the new
 * fetch-script and polling-configuration model:
 *
 *  - Promotes the default configuration's `fetch.sh` to a project-level
 *    `projects/{slug}/fetch.sh` (only if no project-level script already
 *    exists; per-config copies are left in place as a safety net).
 *  - Sets `Project.pollingConfigurationIds` to the IDs of configurations that
 *    previously had `autoBuild: true`, falling back to `[defaultConfigurationId]`.
 *  - Removes `BuildConfiguration.autoBuild` from every configuration.
 *
 * Idempotent: each step is guarded so re-running on already-migrated data is
 * a no-op.
 */
export async function runMigrations(dataPath: string): Promise<void> {
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

		// 2. Seed `pollingConfigurationIds` from the legacy `autoBuild` flags.
		if (project.pollingConfigurationIds === undefined) {
			const fromAutoBuild = project.configurations
				.filter(c => c.autoBuild === true)
				.map(c => c.id);
			project.pollingConfigurationIds = fromAutoBuild.length > 0
				? fromAutoBuild
				: project.defaultConfigurationId
					? [project.defaultConfigurationId]
					: [];
			mutated = true;
			console.log(`[migrate] ${project.slug}: pollingConfigurationIds = [${project.pollingConfigurationIds.join(', ')}]`);
		}

		// 3. Drop the obsolete per-config `autoBuild` field.
		for (const config of project.configurations) {
			if ('autoBuild' in config) {
				delete config.autoBuild;
				mutated = true;
			}
		}
	}

	if (mutated) {
		const tmp = projectsFile + '.tmp';
		await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
		await fs.rename(tmp, projectsFile);
		console.log('[migrate] projects.json updated.');
	}
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
