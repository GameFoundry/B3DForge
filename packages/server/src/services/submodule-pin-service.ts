import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import type { PinInspection, PinUpdate, SubmodulePin, TreeRepository, UpdatePinsResult } from '@banshee-forge/shared';
import { parseGitmodules, resolveSubmoduleUrl } from '@banshee-forge/shared';
import { git, gitRaw, gitRemoteBranchHead, isFullSha, type GitOptions } from '@banshee-forge/shared/node';

export interface InspectPinsInput {
	rootUrl: string;
	/** Branch whose head defines the tree; submodules are compared with their branch of the same name. */
	branch: string;
	/** Explicit root commit instead of the branch head. */
	rootCommit?: string;
}

export interface UpdatePinsServiceInput {
	/** Display name of the root repository, for the update report. */
	rootName: string;
	rootUrl: string;
	branch: string;
	/** Root head the caller inspected; the update is refused when the branch moved since. */
	expectedRootCommit: string;
	credentials?: GitPushCredentials;
}

/** HTTP credentials for pushing to the remotes; absent means the orchestrator's own Git setup is used. */
export interface GitPushCredentials {
	user: string;
	token: string;
}

/** Thrown when a pin update cannot proceed; the message explains what to do. */
export class PinUpdateError extends Error {
	constructor(message: string, readonly conflict = false) {
		super(message);
		this.name = 'PinUpdateError';
	}
}

/** Identity stamped on the pin commits an update creates. */
const COMMITTER = { 'user.name': 'BansheeForge', 'user.email': 'bansheeforge@banshee3d.io' };

/** A submodule of the inspection together with what its parent must pin after an update. */
interface PinNode {
	pin: SubmodulePin;
	/** Commit this repository is inspected at: the branch head when it has one, else the pin. */
	base: string;
	children: PinNode[];
}

/**
 * Reads and updates the submodule pins of a tree without a working checkout. The root commit
 * of a branch defines the whole tree through its gitlinks, recursively; this service compares
 * each gitlink with the head of the submodule's branch and, on request, writes pin commits so
 * the branch head pins every branch head below it.
 *
 * Reading `.gitmodules` and gitlinks at arbitrary commits needs the objects locally, so a bare
 * cache repository per URL is kept under the data directory. Promotion uses the same caches.
 */
export class SubmodulePinService {
	private readonly cacheRoot: string;
	/** Serializes git operations per cache repository; concurrent fetches into one repository corrupt its refs. */
	private readonly locks = new Map<string, Promise<unknown>>();

	constructor(dataPath: string) {
		this.cacheRoot = path.join(dataPath, 'git-cache');
	}

	/** Head of a branch, or an explicit commit resolved to its full id. */
	async resolveRootCommit(rootUrl: string, branch: string, rootCommit?: string): Promise<string> {
		if (rootCommit) {
			if (isFullSha(rootCommit)) return rootCommit;
			// A short id or ref: fetch the branch into the cache and resolve it there.
			const cache = await this.cacheFor(rootUrl);
			await this.withLock(cache, () => git(['fetch', '--quiet', rootUrl, `refs/heads/${branch}`], { cwd: cache }));
			const result = await gitRaw(['rev-parse', '--verify', `${rootCommit}^{commit}`], { cwd: cache });
			if (result.exitCode !== 0) throw new Error(`Commit '${rootCommit}' not found on branch '${branch}' of ${rootUrl}`);
			return result.stdout.trim();
		}

		const head = await gitRemoteBranchHead(rootUrl, branch);
		if (!head) throw new Error(`Branch '${branch}' does not exist in ${rootUrl}`);
		return head;
	}

	/** Compare every submodule pin of the tree with the head of the submodule's branch. */
	async inspect(input: InspectPinsInput): Promise<PinInspection> {
		const rootCommit = await this.resolveRootCommit(input.rootUrl, input.branch, input.rootCommit);
		const nodes = await this.collect(input.rootUrl, rootCommit, '', 1, input.branch);
		return {
			branch: input.branch,
			rootCommit,
			submodules: flatten(nodes),
			inspectedAt: new Date().toISOString(),
		};
	}

	/**
	 * Every repository of the tree a root commit defines, parents before children, at the commits
	 * the gitlinks pin. This is exactly what a build of that commit checks out.
	 */
	async resolveTree(rootName: string, rootUrl: string, rootCommit: string): Promise<TreeRepository[]> {
		const repositories: TreeRepository[] = [];
		const walk = async (entry: TreeRepository) => {
			repositories.push(entry);
			for (const child of await this.submodulesAt(entry.url, entry.commit)) {
				await walk({
					path: entry.path ? `${entry.path}/${child.path}` : child.path,
					name: child.name,
					url: child.url,
					commit: child.pinned,
					depth: entry.depth + 1,
				});
			}
		};
		await walk({ path: '', name: rootName, url: rootUrl, commit: rootCommit, depth: 0 });
		return repositories;
	}

	/**
	 * Write pin commits so that, children first, every repository on the branch pins the branch
	 * heads of its submodules, and push each one with a plain (non-forced) push. A push the remote
	 * rejects means someone pushed meanwhile: nothing further is pushed and the caller re-inspects.
	 */
	async updatePins(input: UpdatePinsServiceInput): Promise<UpdatePinsResult> {
		const head = await gitRemoteBranchHead(input.rootUrl, input.branch);
		if (!head) throw new PinUpdateError(`Branch '${input.branch}' does not exist in ${input.rootUrl}`);
		if (head !== input.expectedRootCommit)
			throw new PinUpdateError(`Branch '${input.branch}' moved from ${short(input.expectedRootCommit)} to ${short(head)} since it was inspected; review the pins again.`, true);

		const nodes = await this.collect(input.rootUrl, head, '', 1, input.branch);
		const updates: PinUpdate[] = [];
		const gitOptions = this.gitOptions(input.credentials);

		const rootCommit = await this.updateRepository({ path: '', name: input.rootName, url: input.rootUrl, base: head, branch: input.branch, children: nodes }, updates, gitOptions);
		return { branch: input.branch, rootCommit, updates };
	}

	/** Re-pin the children of one repository (after updating them) and push the result. Returns the new tip. */
	private async updateRepository(
		repo: { path: string; name: string; url: string; base: string; branch: string; children: PinNode[] },
		updates: PinUpdate[],
		gitOptions: GitOptions,
	): Promise<string> {
		const pins: Record<string, string> = {};
		for (const child of repo.children) {
			// A child without a branch keeps its pin; one with a branch is updated first so the
			// parent pins the child's new tip.
			if (!child.pin.branch || !child.pin.head) continue;
			const childTip = await this.updateRepository({
				path: child.pin.path,
				name: child.pin.name,
				url: child.pin.url,
				base: child.pin.head,
				branch: child.pin.branch,
				children: child.children,
			}, updates, gitOptions);
			if (childTip !== child.pin.pinned) pins[relativeTo(repo.path, child.pin.path)] = childTip;
		}
		if (Object.keys(pins).length === 0) return repo.base;

		const cache = await this.cacheFor(repo.url);
		await this.ensureCommit(cache, repo.url, repo.base, repo.branch);
		const commit = await this.createPinCommit(cache, repo.base, pins, repo.branch);

		const push = await gitRaw(['push', '--quiet', repo.url, `${commit}:refs/heads/${repo.branch}`], { cwd: cache, ...gitOptions, timeoutMs: 5 * 60 * 1000 });
		if (push.exitCode !== 0) {
			const rejected = /rejected|fetch first|non-fast-forward|stale info/i.test(push.stderr);
			throw new PinUpdateError(
				rejected
					? `${repo.name}: '${repo.branch}' moved while the pins were being updated; review the pins again.`
					: `${repo.name}: push to ${repo.url} failed: ${push.stderr.trim()}`,
				rejected,
			);
		}
		updates.push({ path: repo.path, name: repo.name, from: repo.base, to: commit, pins });
		return commit;
	}

	/** Commit whose tree is `base` with the given gitlinks replaced, built in a scratch index. */
	private async createPinCommit(cache: string, base: string, pins: Record<string, string>, branch: string): Promise<string> {
		const indexFile = path.join(os.tmpdir(), `forge-pins-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.index`);
		const env = { GIT_INDEX_FILE: indexFile };
		try {
			await git(['read-tree', base], { cwd: cache, env });
			for (const [relativePath, commit] of Object.entries(pins))
				await git(['update-index', '--add', '--cacheinfo', `160000,${commit},${relativePath}`], { cwd: cache, env });
			const tree = await git(['write-tree'], { cwd: cache, env });
			const summary = Object.entries(pins).map(([p, c]) => `${p} to ${short(c)}`).join(', ');
			const message = `Update submodule pins: ${summary}\n\nPinned to the heads of '${branch}' by BansheeForge.`;
			return await git(['commit-tree', tree, '-p', base, '-m', message], { cwd: cache, config: COMMITTER });
		} finally {
			await fs.rm(indexFile, { force: true });
		}
	}

	/**
	 * The submodules a commit declares, each compared with the head of its branch, recursively.
	 * Children are inspected at the branch head when the submodule has one (the commit a build
	 * would use after an update), else at the pinned commit.
	 */
	private async collect(url: string, commit: string, parentPath: string, depth: number, branch: string): Promise<PinNode[]> {
		const nodes: PinNode[] = [];
		for (const child of await this.submodulesAt(url, commit)) {
			const childPath = parentPath ? `${parentPath}/${child.path}` : child.path;
			let followed: string | undefined = branch;
			let head = await gitRemoteBranchHead(child.url, branch);
			if (!head && child.branch && child.branch !== branch) {
				followed = child.branch;
				head = await gitRemoteBranchHead(child.url, child.branch);
			}
			if (!head) followed = undefined;

			const pin: SubmodulePin = {
				path: childPath,
				name: child.name,
				url: child.url,
				depth,
				pinned: child.pinned,
				branch: followed,
				head: head ?? undefined,
				stale: !!head && head !== child.pinned,
			};
			const base = head ?? child.pinned;
			nodes.push({ pin, base, children: await this.collect(child.url, base, childPath, depth + 1, branch) });
		}
		return nodes;
	}

	/** Direct submodules of a commit: `.gitmodules` entries with a gitlink, optional overlays excluded. */
	private async submodulesAt(url: string, commit: string): Promise<{ path: string; name: string; url: string; branch?: string; pinned: string }[]> {
		const cache = await this.cacheFor(url);
		await this.ensureCommit(cache, url, commit);

		const gitmodules = await gitRaw(['cat-file', '-p', `${commit}:.gitmodules`], { cwd: cache });
		if (gitmodules.exitCode !== 0) return [];

		const result: { path: string; name: string; url: string; branch?: string; pinned: string }[] = [];
		for (const submodule of parseGitmodules(gitmodules.stdout)) {
			// Optional overlays (`update = none`) are never part of the checkout.
			if (submodule.update === 'none') continue;
			const pinned = await this.gitlinkAt(cache, commit, submodule.path);
			if (!pinned) continue;
			result.push({ path: submodule.path, name: submodule.name, url: resolveSubmoduleUrl(url, submodule.url), branch: submodule.branch, pinned });
		}
		return result;
	}

	/**
	 * Read a file of the tree a root commit defines, at the pinned commits, without a working
	 * tree. The path is relative to the workspace root and may reach into a submodule. Returns
	 * null when no such file exists.
	 */
	async readFile(rootUrl: string, rootCommit: string, workspacePath: string): Promise<string | null> {
		const normalized = workspacePath.replace(/\\/g, '/').replace(/^\/+/, '');
		let url = rootUrl;
		let commit = rootCommit;
		let relative = normalized;
		// Descend through submodules while a prefix of the path is one.
		for (;;) {
			const submodules = await this.submodulesAt(url, commit);
			const owner = submodules.find(s => relative.startsWith(s.path + '/'));
			if (!owner) break;
			url = owner.url;
			commit = owner.pinned;
			relative = relative.slice(owner.path.length + 1);
		}
		const cache = await this.cacheFor(url);
		const result = await gitRaw(['cat-file', '-p', `${commit}:${relative}`], { cwd: cache });
		return result.exitCode === 0 ? result.stdout : null;
	}

	/** Bare cache repository for a URL; promotion shares it. */
	async cacheFor(url: string): Promise<string> {
		const key = createHash('sha1').update(url.trim().toLowerCase()).digest('hex').slice(0, 16);
		const cache = path.join(this.cacheRoot, key);
		try {
			await fs.access(path.join(cache, 'HEAD'));
		} catch {
			await fs.mkdir(cache, { recursive: true });
			await git(['init', '--bare', '--quiet'], { cwd: cache });
		}
		return cache;
	}

	/**
	 * Make a commit's objects available in the cache, with full history so merge bases can be
	 * computed. A direct fetch of the commit is tried first; remotes that refuse it get the
	 * branch fetched instead. The commit is pinned by a ref so garbage collection keeps it.
	 */
	async ensureCommit(cache: string, url: string, commit: string, branch?: string, gitOptions: GitOptions = {}): Promise<void> {
		await this.withLock(cache, async () => {
			// Caches created by an earlier version were shallow; merge bases need full history.
			const unshallow = await this.isShallow(cache) ? ['--unshallow'] : [];
			const present = await gitRaw(['cat-file', '-e', `${commit}^{commit}`], { cwd: cache });
			if (present.exitCode !== 0 || unshallow.length > 0) {
				const direct = await gitRaw(['fetch', '--quiet', ...unshallow, url, commit], { cwd: cache, ...gitOptions });
				if (direct.exitCode !== 0) {
					if (!branch) throw new Error(`Commit ${commit} of ${url} cannot be fetched directly and no branch was given to fetch instead`);
					await git(['fetch', '--quiet', ...unshallow, url, `refs/heads/${branch}`], { cwd: cache, ...gitOptions });
					const after = await gitRaw(['cat-file', '-e', `${commit}^{commit}`], { cwd: cache });
					if (after.exitCode !== 0) throw new Error(`Commit ${commit} of ${url} is not reachable from branch '${branch}' and cannot be fetched directly`);
				}
			}
			await git(['update-ref', `refs/keep/${commit}`, commit], { cwd: cache });
		});
	}

	private async isShallow(cache: string): Promise<boolean> {
		try {
			await fs.access(path.join(cache, 'shallow'));
			return true;
		} catch {
			return false;
		}
	}

	/** Run work while holding the cache's lock, for callers that combine several git commands. */
	async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = this.locks.get(key) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(work);
		this.locks.set(key, next);
		try {
			return await next;
		} finally {
			if (this.locks.get(key) === next) this.locks.delete(key);
		}
	}

	async gitlinkAt(cache: string, commit: string, submodulePath: string): Promise<string | null> {
		const result = await gitRaw(['ls-tree', commit, '--', submodulePath], { cwd: cache });
		if (result.exitCode !== 0) return null;
		// "<mode> <type> <sha>\t<path>"; a gitlink has mode 160000.
		const match = result.stdout.trim().match(/^160000\s+commit\s+([0-9a-f]{40})\t/);
		return match ? match[1] : null;
	}

	/** Git options carrying HTTP basic credentials for fetch and push, when configured. */
	gitOptions(credentials?: GitPushCredentials): GitOptions {
		if (!credentials) return {};
		const basic = Buffer.from(`${credentials.user}:${credentials.token}`).toString('base64');
		return { config: { 'http.extraHeader': `Authorization: Basic ${basic}`, 'credential.helper': '' } };
	}
}

function flatten(nodes: PinNode[]): SubmodulePin[] {
	const result: SubmodulePin[] = [];
	for (const node of nodes) {
		result.push(node.pin);
		result.push(...flatten(node.children));
	}
	return result;
}

/** Path of a child relative to the repository at `parentPath`. */
function relativeTo(parentPath: string, childPath: string): string {
	return parentPath ? childPath.slice(parentPath.length + 1) : childPath;
}

function short(sha: string): string {
	return sha.slice(0, 7);
}

/** Read the optional Git push identity from the key=value credentials file. */
export async function readGitCredentials(credentialsFile: string | undefined): Promise<GitPushCredentials | undefined> {
	if (!credentialsFile) return undefined;
	let text: string;
	try {
		text = await fs.readFile(credentialsFile, 'utf-8');
	} catch {
		return undefined;
	}
	const values: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#') || !line.includes('=')) continue;
		const key = line.slice(0, line.indexOf('=')).trim();
		let value = line.slice(line.indexOf('=') + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		values[key] = value;
	}
	if (!values.GIT_TOKEN) return undefined;
	return { user: values.GIT_USER || 'x-access-token', token: values.GIT_TOKEN };
}
