import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import type { BuildDeploymentInputs, DeploymentFile } from '@banshee-forge/shared';

/** Name of the per-build subdirectory the build script fills with deploy files. */
export const DEPLOY_DIR_NAME = 'deploy';

/**
 * Record every file the build script left under `{buildDir}/deploy` for a later deployment,
 * with its size and SHA-256, so the orchestrator can request exactly these files and verify
 * them on arrival. What the files mean is the build script's business (it must leave a
 * `deploy.sh` among them for the build to be deployable). Returns null when the directory is
 * missing or empty, e.g. a build script that predates deployment support.
 */
export async function collectDeploymentInputs(buildDir: string): Promise<BuildDeploymentInputs | null> {
	const deployDir = path.join(buildDir, DEPLOY_DIR_NAME);
	const files: DeploymentFile[] = [];
	const walk = async (dir: string, prefix: string) => {
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			const filePath = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(filePath, relative);
			else if (entry.isFile()) files.push({ path: relative, size: (await fs.stat(filePath)).size, sha256: await hashFile(filePath) });
		}
	};
	await walk(deployDir, '');
	return files.length > 0 ? { files } : null;
}

/** SHA-256 of a file, streamed so multi-gigabyte archives never sit in memory. */
export function hashFile(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		createReadStream(filePath)
			.on('data', chunk => hash.update(chunk))
			.on('error', reject)
			.on('end', () => resolve(hash.digest('hex')));
	});
}
