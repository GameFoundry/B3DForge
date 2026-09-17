import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { git } from '@banshee-forge/shared/node';

const IDENTITY = { 'user.name': 'Fixture', 'user.email': 'fixture@example.com', 'commit.gpgsign': 'false', 'core.autocrlf': 'false' };

export async function run(cwd: string, args: string[]): Promise<string> {
	return git(args, { cwd, config: IDENTITY });
}

export async function makeTempDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** `file://` URL git accepts for a local bare repository, on every platform. */
export function fileUrl(dir: string): string {
	return pathToFileURL(dir).href;
}

/**
 * A bare repository plus a work clone. Commits go into the clone and are pushed to the bare
 * repository, which plays the role of the remote the services talk to.
 */
export class Repo {
	constructor(readonly bare: string, readonly work: string, readonly url: string) {}

	static async create(root: string, name: string): Promise<Repo> {
		const bare = path.join(root, `${name}.git`);
		const work = path.join(root, `${name}-work`);
		await fs.mkdir(bare, { recursive: true });
		await run(bare, ['init', '--bare', '--quiet', '--initial-branch=master']);
		await run(root, ['clone', '--quiet', fileUrl(bare), work]);
		return new Repo(bare, work, fileUrl(bare));
	}

	async commitFile(file: string, content: string, message: string): Promise<string> {
		await fs.mkdir(path.dirname(path.join(this.work, file)), { recursive: true });
		await fs.writeFile(path.join(this.work, file), content, 'utf-8');
		await run(this.work, ['add', '--', file]);
		await run(this.work, ['commit', '--quiet', '-m', message]);
		return run(this.work, ['rev-parse', 'HEAD']);
	}

	/** Record a submodule gitlink without cloning anything into the work tree. */
	async setGitlink(submodulePath: string, commit: string, url: string, branch: string, message: string): Promise<string> {
		const gitmodules = path.join(this.work, '.gitmodules');
		let text = '';
		try { text = await fs.readFile(gitmodules, 'utf-8'); } catch { /* first submodule */ }
		if (!text.includes(`path = ${submodulePath}`))
			text += `[submodule "${submodulePath}"]\n\tpath = ${submodulePath}\n\turl = ${url}\n\tbranch = ${branch}\n`;
		await fs.writeFile(gitmodules, text, 'utf-8');
		await run(this.work, ['add', '--', '.gitmodules']);
		await run(this.work, ['update-index', '--add', '--cacheinfo', `160000,${commit},${submodulePath}`]);
		await run(this.work, ['commit', '--quiet', '-m', message]);
		return run(this.work, ['rev-parse', 'HEAD']);
	}

	async checkout(branch: string, create = false): Promise<void> {
		await run(this.work, create ? ['checkout', '--quiet', '-b', branch] : ['checkout', '--quiet', branch]);
	}

	/** Check out `branch` at the remote's current tip, discarding whatever the clone had. */
	async sync(branch: string): Promise<void> {
		await run(this.work, ['fetch', '--quiet', '--recurse-submodules=no', 'origin']);
		await run(this.work, ['checkout', '--quiet', '-B', branch, `origin/${branch}`]);
	}

	async push(...branches: string[]): Promise<void> {
		await run(this.work, ['push', '--quiet', '--recurse-submodules=no', 'origin', ...branches]);
	}

	async remoteHead(branch: string): Promise<string> {
		return run(this.bare, ['rev-parse', `refs/heads/${branch}`]);
	}

	async gitlinkAt(commit: string, submodulePath: string): Promise<string | null> {
		const out = await run(this.bare, ['ls-tree', commit, '--', submodulePath]);
		const match = out.match(/^160000 commit ([0-9a-f]{40})\t/);
		return match ? match[1] : null;
	}

	async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
		try {
			await run(this.bare, ['merge-base', '--is-ancestor', ancestor, descendant]);
			return true;
		} catch {
			return false;
		}
	}
}
