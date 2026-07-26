import { promises as fs } from 'fs';
import path from 'path';
import type { AgentArtifactUsage, AgentPurgeArtifactsResult } from '@banshee-forge/shared';

/** Name of the per-build subdirectory holding the install tree produced by the build script. */
const ARTIFACTS_DIR_NAME = 'artifacts';

/**
 * Manages the per-build artifact directories at `{buildsRoot}/{buildId}/artifacts`.
 *
 * Artifacts never leave the agent — only logs and test results are uploaded — so nothing prunes
 * them and they accumulate at roughly one full install tree per build. Since no part of the system
 * reads them back, they are safe to delete once a build has finished; only builds that are still
 * running are protected, as their scripts are actively writing into the tree.
 */
export class ArtifactStore {
	/** Guards against overlapping purges, which would double-count the bytes they report. */
	private purging = false;

	constructor(private readonly buildsRoot: string) {
		// Validated here rather than trusted from configuration: this class holds the only
		// recursive delete in the agent, and an empty or relative root would silently retarget it
		// at whatever the process working directory happens to be.
		if (!buildsRoot.trim()) {
			throw new Error('ArtifactStore requires a non-empty buildsRoot');
		}
		if (!path.isAbsolute(buildsRoot)) {
			throw new Error(`ArtifactStore requires an absolute buildsRoot, got '${buildsRoot}'`);
		}
	}

	/**
	 * Total the artifact directories on disk, splitting out the part a purge could reclaim. Walks
	 * the whole tree, so it takes seconds; callers should not block anything interactive on it.
	 *
	 * `isActive` is queried rather than passed as a set so it reflects the builds running at the
	 * moment each directory is examined, not when the request arrived.
	 */
	async measure(isActive: (buildId: string) => boolean): Promise<AgentArtifactUsage> {
		const usage: AgentArtifactUsage = {
			totalBytes: 0,
			buildCount: 0,
			purgeableBytes: 0,
			purgeableCount: 0,
			buildsRoot: this.buildsRoot,
		};

		for (const buildId of await this.listBuildsWithArtifacts()) {
			const bytes = await directorySize(path.join(this.buildsRoot, buildId, ARTIFACTS_DIR_NAME));
			usage.totalBytes += bytes;
			usage.buildCount++;
			if (!isActive(buildId)) {
				usage.purgeableBytes += bytes;
				usage.purgeableCount++;
			}
		}

		return usage;
	}

	/**
	 * Delete the artifacts directory of every build that isn't currently running, reporting the
	 * bytes reclaimed. A build whose directory can't be removed (e.g. a file held open by a
	 * lingering process) is recorded in `errors` and skipped; the rest still get purged.
	 *
	 * `isActive` is re-queried immediately before each delete: listing and sizing the tree is slow
	 * enough that a build can be assigned partway through, and its artifacts must not be pulled out
	 * from under it.
	 */
	async purge(isActive: (buildId: string) => boolean): Promise<AgentPurgeArtifactsResult> {
		if (this.purging) throw new Error('A purge is already in progress');
		this.purging = true;

		const result: AgentPurgeArtifactsResult = {
			deletedCount: 0,
			freedBytes: 0,
			skippedBuildIds: [],
			errors: [],
		};

		try {
			for (const buildId of await this.listBuildsWithArtifacts()) {
				if (isActive(buildId)) {
					result.skippedBuildIds.push(buildId);
					continue;
				}

				const buildDir = path.join(this.buildsRoot, buildId);
				const artifactsDir = path.join(buildDir, ARTIFACTS_DIR_NAME);

				try {
					// Size must be taken before the delete; fs.rm doesn't report what it removed.
					const bytes = await directorySize(artifactsDir);

					// The size walk above takes time, so re-check before committing to the delete.
					if (isActive(buildId)) {
						result.skippedBuildIds.push(buildId);
						continue;
					}

					await fs.rm(artifactsDir, { recursive: true, force: true });
					result.deletedCount++;
					result.freedBytes += bytes;
					await removeIfEmpty(buildDir);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					result.errors.push(`${buildId}: ${message}`);
				}
			}
		} finally {
			this.purging = false;
		}

		return result;
	}

	/**
	 * Build IDs under `buildsRoot` that currently have a real artifacts directory.
	 *
	 * Symlinks and Windows junctions are deliberately excluded at both levels. `fs.rm` would only
	 * unlink such an entry rather than delete through it, so including one would leave the reported
	 * `freedBytes` claiming the whole linked tree while freeing nothing.
	 */
	private async listBuildsWithArtifacts(): Promise<string[]> {
		let entries;
		try {
			entries = await fs.readdir(this.buildsRoot, { withFileTypes: true });
		} catch (err) {
			// The directory only appears once the agent has run its first build.
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw err;
		}

		const buildIds: string[] = [];
		for (const entry of entries) {
			// Dirents are lstat-based, so this already rejects a linked build directory.
			if (!entry.isDirectory()) continue;
			try {
				const stat = await fs.lstat(path.join(this.buildsRoot, entry.name, ARTIFACTS_DIR_NAME));
				if (stat.isDirectory()) buildIds.push(entry.name);
			} catch {
				// No artifacts directory for this build — nothing to report or purge.
			}
		}
		return buildIds;
	}
}

/** Total size of the files beneath `dir`. Symlinks are not followed. */
async function directorySize(dir: string): Promise<number> {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}

	let total = 0;
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			total += await directorySize(full);
		} else if (entry.isFile()) {
			try {
				total += (await fs.stat(full)).size;
			} catch {
				// Vanished mid-walk; it contributes nothing either way.
			}
		}
	}
	return total;
}

/** Remove `dir` if nothing is left in it, so purged builds don't leave empty shells behind. */
async function removeIfEmpty(dir: string): Promise<void> {
	try {
		const remaining = await fs.readdir(dir);
		if (remaining.length === 0) await fs.rmdir(dir);
	} catch {
		// Non-empty or already gone — either way there's nothing to clean up.
	}
}
