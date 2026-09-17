import { promises as fs } from 'fs';
import path from 'path';

/**
 * Directory of the incremental workspace for one project, configuration and target platform:
 * `{workspaceRoot}/{slug}/{configId}/{platform}`.
 *
 * Workspaces used to live one level up, at `{slug}/{configId}`, when an agent built for a single
 * platform. Such a directory (recognisable by its `.git`) is moved into place for the host
 * platform on first use so the existing checkout and build tree keep serving incremental builds.
 * A PS5 workspace on a Windows agent gets its own directory rather than inheriting the legacy one.
 */
export async function resolveWorkspace(workspaceRoot: string, slug: string, configId: string, platform: string): Promise<string> {
	const configDir = path.join(workspaceRoot, slug, configId);
	const workspace = path.join(configDir, platform);

	if (await isLegacyWorkspace(configDir)) {
		if (platform === process.platform) {
			await migrateLegacyWorkspace(configDir, workspace);
		} else {
			// Keep the legacy checkout intact for the host platform's next build; the platform
			// directory can't be created inside it until it has been moved, so do that now.
			await migrateLegacyWorkspace(configDir, path.join(configDir, process.platform));
		}
	}

	return workspace;
}

async function isLegacyWorkspace(configDir: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(path.join(configDir, '.git'));
		return stat.isDirectory() || stat.isFile();
	} catch {
		return false;
	}
}

/**
 * Move the contents of `configDir` into `target` (a child of `configDir`). Done through a sibling
 * temporary directory because a directory cannot be renamed into its own subdirectory.
 */
async function migrateLegacyWorkspace(configDir: string, target: string): Promise<void> {
	const staging = `${configDir}.migrating-${process.pid}`;
	await fs.rename(configDir, staging);
	await fs.mkdir(configDir, { recursive: true });
	await fs.rename(staging, target);
	console.log(`Moved legacy workspace ${configDir} to ${target}`);
}

/**
 * Process-wide mutual exclusion over workspace directories. Two builds of the same configuration
 * and platform assigned concurrently (maxParallelBuilds > 1) would otherwise fetch and build in
 * the same tree at once.
 */
export class WorkspaceLocks {
	private static readonly queues = new Map<string, Array<() => void>>();

	static isHeld(workspace: string): boolean {
		return this.queues.has(this.key(workspace));
	}

	/** Resolves with a release function once the workspace is free; callers wait in FIFO order. */
	static acquire(workspace: string): Promise<() => void> {
		const key = this.key(workspace);
		return new Promise(resolve => {
			const release = () => {
				const waiters = this.queues.get(key);
				if (!waiters) return;
				const next = waiters.shift();
				if (next) next();
				else this.queues.delete(key);
			};
			const grant = () => resolve(once(release));

			const waiters = this.queues.get(key);
			if (waiters) {
				waiters.push(grant);
			} else {
				this.queues.set(key, []);
				grant();
			}
		});
	}

	private static key(workspace: string): string {
		const resolved = path.resolve(workspace);
		return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	}
}

function once(fn: () => void): () => void {
	let called = false;
	return () => {
		if (called) return;
		called = true;
		fn();
	};
}
