import type { PromotionRecord, PromotionRepositoryResult, TreeRepository } from '@banshee-forge/shared';
import { git, gitRaw, GitError, type GitOptions } from '@banshee-forge/shared/node';
import { DeploymentRepository } from '../repositories/deployment-repository.js';
import { SubmodulePinService, type GitPushCredentials } from './submodule-pin-service.js';

export interface PromotionInput {
	projectSlug: string;
	deploymentId: string;
	/** Display name of the root repository. */
	rootName: string;
	rootUrl: string;
	/** Root commit the build tested; it pins every submodule commit. */
	rootCommit: string;
	buildBranch: string;
	targetBranch: string;
	credentials?: GitPushCredentials;
	log: (message: string, level?: 'info' | 'warning' | 'error') => void;
}

/** Thrown when the tested commits cannot be promoted as-is; the message explains what to resolve. */
export class PromotionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PromotionError';
	}
}

/** Identity stamped on the merge commits a promotion creates. */
const COMMITTER = { 'user.name': 'BansheeForge', 'user.email': 'bansheeforge@banshee3d.io' };

/** Per-repository outcome computed by the preflight, before anything is pushed. */
interface RepositoryPlan {
	repository: TreeRepository;
	cache: string;
	result: PromotionRepositoryResult;
}

/**
 * Pushes the tested commit of every repository in a tree to the target branch, children before
 * parents, so that a parent on the target branch never pins a child commit the child's target
 * branch lacks. A target that did not move fast-forwards; one that moved receives a merge
 * commit (`--no-ff`); a conflict fails the promotion. The build branch is never touched and no
 * pin commits are written: what was tested is what lands.
 *
 * Nothing is pushed until every repository passed preflight. Pushes are journaled per
 * repository; re-running the same root commit resumes from the journal and reuses a completed one.
 */
export class PromotionService {
	/** Promotions touch several repositories at once, so they are serialized globally. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly pins: SubmodulePinService, private readonly deployments: DeploymentRepository) {}

	async promote(input: PromotionInput): Promise<PromotionRecord> {
		const run = this.queue.catch(() => undefined).then(() => this.promoteSerialized(input));
		this.queue = run;
		return run;
	}

	private async promoteSerialized(input: PromotionInput): Promise<PromotionRecord> {
		const { log } = input;

		const existing = await this.deployments.findPromotion(input.projectSlug, input.rootCommit, input.targetBranch);
		if (existing?.status === 'complete') {
			log(`Commit ${short(input.rootCommit)} was already promoted to ${input.targetBranch} by deployment ${existing.deploymentId}; reusing it.`);
			return existing;
		}
		if (existing) log(`Resuming promotion of ${short(input.rootCommit)} left in state '${existing.status}' by deployment ${existing.deploymentId}.`);

		const gitOptions = this.pins.gitOptions(input.credentials);

		// Children first, so a parent is never promoted ahead of the commits it pins.
		const tree = await this.pins.resolveTree(input.rootName, input.rootUrl, input.rootCommit);
		const ordered = [...tree].sort((a, b) => b.depth - a.depth || a.path.localeCompare(b.path));

		log('Preflighting promotion...');
		const plans: RepositoryPlan[] = [];
		for (const repository of ordered) {
			const plan = await this.preflight(repository, input, gitOptions);
			plans.push(plan);
			const r = plan.result;
			log(`${repository.name}: ${input.targetBranch} ${short(r.previousTarget) || '(new)'} -> ${short(r.newTarget)} (${r.integration})`);
		}

		const record: PromotionRecord = {
			rootCommit: input.rootCommit,
			targetBranch: input.targetBranch,
			deploymentId: input.deploymentId,
			status: 'pushing',
			repositories: plans.map(p => p.result),
			startedAt: existing?.startedAt ?? new Date().toISOString(),
		};
		await this.deployments.savePromotion(input.projectSlug, record);

		for (const plan of plans) {
			const { repository, result } = plan;
			if (result.integration === 'unchanged') {
				result.pushed = true;
				log(`${repository.name}: remote already up to date.`);
			} else {
				log(`${repository.name}: pushing ${short(result.newTarget)} to ${input.targetBranch}...`);
				const push = await gitRaw(['push', '--quiet', '--atomic', repository.url, `${result.newTarget}:refs/heads/${input.targetBranch}`], { cwd: plan.cache, ...gitOptions, timeoutMs: 10 * 60 * 1000 });
				if (push.exitCode !== 0) {
					const rejected = /rejected|fetch first|non-fast-forward|stale info/i.test(push.stderr);
					record.status = 'failed';
					record.error = rejected
						? `${repository.name}: '${input.targetBranch}' moved while the promotion was running; retry the deployment.`
						: `Push to ${repository.name} failed: ${push.stderr.trim()}`;
					record.finishedAt = new Date().toISOString();
					await this.deployments.savePromotion(input.projectSlug, record);
					throw new PromotionError(record.error);
				}
				result.pushed = true;
			}
			await this.deployments.savePromotion(input.projectSlug, record);
		}

		record.status = 'complete';
		record.finishedAt = new Date().toISOString();
		await this.deployments.savePromotion(input.projectSlug, record);
		log('Promotion complete.');
		return record;
	}

	/**
	 * Decide how one repository's target branch absorbs the tested commit: created, unchanged,
	 * fast-forwarded, or merged. A merge commit is created locally here; nothing is pushed.
	 */
	private async preflight(repository: TreeRepository, input: PromotionInput, gitOptions: GitOptions): Promise<RepositoryPlan> {
		const cache = await this.pins.cacheFor(repository.url);
		await this.pins.ensureCommit(cache, repository.url, repository.commit, input.buildBranch, gitOptions);

		const remoteTarget = await this.remoteBranchHead(cache, repository.url, input.targetBranch, gitOptions);
		const tested = repository.commit;

		let newTarget = tested;
		let integration: PromotionRepositoryResult['integration'] = 'fast-forward';
		if (!remoteTarget) {
			integration = 'fast-forward';
		} else if (remoteTarget === tested || await this.isAncestor(cache, tested, remoteTarget)) {
			// The target already contains the tested commit.
			newTarget = remoteTarget;
			integration = 'unchanged';
		} else if (await this.isAncestor(cache, remoteTarget, tested)) {
			integration = 'fast-forward';
		} else {
			newTarget = await this.mergeCommit(cache, remoteTarget, tested, repository, input);
			integration = 'merge';
		}

		return {
			repository,
			cache,
			result: {
				path: repository.path,
				name: repository.name,
				url: repository.url,
				testedCommit: tested,
				previousTarget: remoteTarget ?? '',
				newTarget,
				integration,
				pushed: false,
			},
		};
	}

	/** Head of the remote target branch, fetched into the cache with its history. */
	private async remoteBranchHead(cache: string, url: string, branch: string, gitOptions: GitOptions): Promise<string | null> {
		const result = await this.pins.withLock(cache, async () => {
			const fetched = await gitRaw(['fetch', '--quiet', url, `+refs/heads/${branch}:refs/promote/${branch}`], { cwd: cache, ...gitOptions });
			if (fetched.exitCode !== 0) {
				// A missing branch is the only acceptable failure; anything else is a real error.
				if (/couldn't find remote ref|fatal: remote error/i.test(fetched.stderr)) return null;
				throw new PromotionError(`Could not fetch '${branch}' from ${url}: ${fetched.stderr.trim()}`);
			}
			return git(['rev-parse', `refs/promote/${branch}`], { cwd: cache });
		});
		return result;
	}

	/**
	 * Merge the tested commit into an advanced target with a real merge commit (`--no-ff`),
	 * without a working tree: `merge-tree --write-tree` (git 2.38+) produces the merged tree or
	 * reports the conflicts. Conflicts fail the promotion.
	 */
	private async mergeCommit(cache: string, target: string, tested: string, repository: TreeRepository, input: PromotionInput): Promise<string> {
		const merge = await gitRaw(['merge-tree', '--write-tree', '--messages', target, tested], { cwd: cache });
		if (merge.exitCode === 1) {
			const conflicts = merge.stdout.split('\n').slice(1).filter(Boolean).join('\n');
			throw new PromotionError(`${repository.name}: merging ${input.buildBranch} (${short(tested)}) into ${input.targetBranch} (${short(target)}) conflicts. Merge ${input.targetBranch} into ${input.buildBranch} by hand, rebuild, and deploy again.\n${conflicts}`);
		}
		if (merge.exitCode !== 0) {
			if (/unknown option|usage: git merge-tree/i.test(merge.stderr)) throw new PromotionError('git 2.38 or newer is required on the orchestrator for merge promotions (git merge-tree --write-tree)');
			throw new GitError(['merge-tree', '--write-tree', target, tested], merge, cache);
		}
		const tree = merge.stdout.split('\n')[0].trim();
		const message = `Merge ${input.buildBranch} into ${input.targetBranch}\n\nDeployment ${input.deploymentId} of ${short(input.rootCommit)} by BansheeForge.`;
		return git(['commit-tree', tree, '-p', target, '-p', tested, '-m', message], { cwd: cache, config: COMMITTER });
	}

	private async isAncestor(cache: string, ancestor: string, descendant: string): Promise<boolean> {
		const result = await gitRaw(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: cache });
		if (result.exitCode === 0) return true;
		if (result.exitCode === 1) return false;
		throw new GitError(['merge-base', '--is-ancestor', ancestor, descendant], result, cache);
	}
}

function short(sha: string | null | undefined): string {
	return sha ? sha.slice(0, 7) : '';
}
