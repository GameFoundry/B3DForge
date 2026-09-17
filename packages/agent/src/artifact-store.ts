import { promises as fs } from 'fs';
import path from 'path';
import type { AgentArtifactUsage, AgentPurgeArtifactsResult } from '@banshee-forge/shared';
import { DEPLOY_DIR_NAME } from './deployment-inputs.js';

/** Name of the per-build subdirectory holding the install tree produced by the build script. */
const ARTIFACTS_DIR_NAME = 'artifacts';

/** Per-build directories a purge removes: the install tree and the packaged deployment inputs. */
const PURGED_DIR_NAMES = [ARTIFACTS_DIR_NAME, DEPLOY_DIR_NAME];

/**
 * Manages the per-build artifact directories at `{buildsRoot}/{buildId}/artifacts` and the
 * deployment inputs beside them at `{buildsRoot}/{buildId}/deploy`.
 *
 * Artifacts stay on the agent until a deployment asks for them — only logs and test results are
 * uploaded at the end of a build — so nothing prunes them and they accumulate at roughly one full
 * install tree per build. A purge deletes them for every build that is neither running nor
 * protected by the orchestrator (a build a pending or running deployment still needs).
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
	 * `isProtected` is queried rather than passed as a set so it reflects the builds running at
	 * the moment each directory is examined, not when the request arrived.
	 */
	async measure(isProtected: (buildId: string) => boolean): Promise<AgentArtifactUsage> {
		const usage: AgentArtifactUsage = {
			totalBytes: 0,
			buildCount: 0,
			purgeableBytes: 0,
			purgeableCount: 0,
			buildsRoot: this.buildsRoot,
		};

		for (const buildId of await this.listBuildsWithArtifacts()) {
			const bytes = await this.buildSize(buildId);
			usage.totalBytes += bytes;
			usage.buildCount++;
			if (!isProtected(buildId)) {
				usage.purgeableBytes += bytes;
				usage.purgeableCount++;
			}
		}

		return usage;
	}

	/**
	 * Delete the artifact and deployment-input directories of every build that is neither running
	 * nor protected, reporting the bytes reclaimed. A build whose directory can't be removed (e.g.
	 * a file held open by a lingering process) is recorded in `errors` and skipped; the rest still
	 * get purged.
	 *
	 * `isProtected` is re-queried immediately before each delete: listing and sizing the tree is
	 * slow enough that a build can be assigned partway through, and its artifacts must not be
	 * pulled out from under it.
	 */
	async purge(isProtected: (buildId: string) => boolean): Promise<AgentPurgeArtifactsResult> {
		if (this.purging) throw new Error('A purge is already in progress');
		this.purging = true;

		const result: AgentPurgeArtifactsResult = {
			deletedCount: 0,
			freedBytes: 0,
			skippedBuildIds: [],
			deletedBuildIds: [],
			errors: [],
		};

		try {
			for (const buildId of await this.listBuildsWithArtifacts()) {
				if (isProtected(buildId)) {
					result.skippedBuildIds.push(buildId);
					continue;
				}

				const buildDir = path.join(this.buildsRoot, buildId);

				try {
					// Size must be taken before the delete; fs.rm doesn't report what it removed.
					const bytes = await this.buildSize(buildId);

					// The size walk above takes time, so re-check before committing to the delete.
					if (isProtected(buildId)) {
						result.skippedBuildIds.push(buildId);
						continue;
					}

					for (const name of PURGED_DIR_NAMES) {
						await fs.rm(path.join(buildDir, name), { recursive: true, force: true });
					}
					result.deletedCount++;
					result.deletedBuildIds.push(buildId);
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

	private async buildSize(buildId: string): Promise<number> {
		let total = 0;
		for (const name of PURGED_DIR_NAMES) {
			total += await directorySize(path.join(this.buildsRoot, buildId, name));
		}
		return total;
	}

	/**
	 * Build IDs under `buildsRoot` that currently have a real artifacts or deploy directory.
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
			for (const name of PURGED_DIR_NAMES) {
				try {
					const stat = await fs.lstat(path.join(this.buildsRoot, entry.name, name));
					if (stat.isDirectory()) { buildIds.push(entry.name); break; }
				} catch {
					// No such directory for this build — try the next name.
				}
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
