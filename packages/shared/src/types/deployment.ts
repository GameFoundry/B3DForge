import type { BuildPhase, TriggerType } from './build.js';

/**
 * Lifecycle of a deployment. `transferring` fetches the build's deploy files from the agent
 * that produced it, `running` executes `deploy.sh` on the orchestrator, and `promoting` pushes
 * the tested commits to the target branch (skipped when no target branch was chosen).
 */
export type DeploymentStatus =
	| 'pending'
	| 'transferring'
	| 'running'
	| 'promoting'
	| 'success'
	| 'failed'
	| 'cancelled';

/** A file of a build's deploy directory, as recorded by the agent and verified by the orchestrator. */
export interface DeploymentFile {
	/** Path relative to the deploy directory, using forward slashes. */
	path: string;
	size: number;
	sha256: string;
}

/**
 * What a finished build left in its deploy directory for a later deployment. Recorded by the
 * agent when the build completes and kept with the build so eligibility can be decided without
 * contacting the agent.
 */
export interface BuildDeploymentInputs {
	files: DeploymentFile[];
	/** True once the agent purged the build's artifacts; the files are gone and the build cannot be deployed. */
	purged?: boolean;
}

/** Name of the script a build must leave in its deploy directory for the build to be deployable. */
export const DEPLOY_SCRIPT_NAME = 'deploy.sh';

/** A file `deploy.sh` left in its output directory, kept with the deployment for download. */
export interface DeploymentArtifact {
	/** Path relative to the output directory, using forward slashes; unique within the deployment. */
	path: string;
	size: number;
}

/** One line of the results file `deploy.sh` writes: `item<TAB>status<TAB>message`. */
export interface DeploymentResult {
	item: string;
	status: string;
	message?: string;
}

/** Per-repository outcome of a Git promotion. */
export interface PromotionRepositoryResult {
	path: string;
	name: string;
	url: string;
	testedCommit: string;
	/** Target branch tip before and after promotion; empty `previousTarget` when the branch was created. */
	previousTarget: string;
	newTarget: string;
	/** How the target absorbed the tested commit. */
	integration: 'fast-forward' | 'merge' | 'unchanged';
	/** True once the ref was pushed to the remote. */
	pushed: boolean;
}

/**
 * Journal of the Git promotion of one root commit to one target branch. Shared by every
 * deployment of that commit: the first deployment performs the promotion, later ones (other
 * platforms) reuse it.
 */
export interface PromotionRecord {
	rootCommit: string;
	targetBranch: string;
	deploymentId: string;
	status: 'pushing' | 'complete' | 'failed';
	/** Repositories in push order (children before parents). */
	repositories: PromotionRepositoryResult[];
	error?: string;
	startedAt: string;
	finishedAt?: string;
}

/**
 * Whether promotion waits for a single build or for every build of its group. Group scope is
 * used by auto-deploy so that the target branch only moves once all platforms deployed.
 */
export type PromotionScope = 'build' | 'group';

/** A deployment of one successful build. */
export interface Deployment {
	id: string;
	projectSlug: string;
	buildId: string;
	buildNumber: number;
	groupId?: string;
	platform: string;
	configurationId: string;
	/** Root commit the build checked out; every submodule is pinned by it. */
	rootCommit: string;
	buildBranch: string;
	status: DeploymentStatus;
	/** Why the deployment is waiting, e.g. the originating agent is offline. */
	pendingReason?: string;
	error?: string;
	triggerType: TriggerType;
	triggeredBy?: string;
	/** Values of the configuration's deploy parameters, passed to `deploy.sh` as environment. */
	parameters: Record<string, string>;
	/** Branch the tested commits are promoted to; absent for a deployment without promotion. */
	targetBranch?: string;
	promotionScope: PromotionScope;
	phases: BuildPhase[];
	/** Deploy files received from the agent. */
	files: DeploymentFile[];
	/** Files `deploy.sh` left in its output directory. */
	artifacts: DeploymentArtifact[];
	/** Rows of the results file `deploy.sh` wrote. */
	results: DeploymentResult[];
	/** Set once promotion finished (or was reused from an earlier deployment of the same commit). */
	promotion?: PromotionRecord;
	/** True when this deployment reused a promotion performed by an earlier deployment. */
	promotionReused?: boolean;
	/** Name of the agent that produced the build; it holds the deploy files. */
	agentName: string;
	/** Token identity of the agent, used to authenticate its uploads. */
	agentTokenId?: string;
	/** Retry counter, starting at 1. */
	attempt: number;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
}

/** Server-side verdict on whether a build may be deployed. */
export interface DeploymentEligibility {
	eligible: boolean;
	/** Human-readable reasons when not eligible; empty when eligible. */
	reasons: string[];
	/** Branch offered as the promotion target by default (the project's deploy branch); blank disables promotion. */
	defaultTargetBranch: string;
	/** Branch the build was made from; promoting to it is a no-op and is skipped. */
	buildBranch: string;
	/** Deployments already recorded for this build, newest first. */
	deployments: Deployment[];
}

/** Body of `POST /builds/:id/deployments`. */
export interface CreateDeploymentInput {
	/** Values for the configuration's deploy parameters, keyed by parameter name. */
	parameters?: Record<string, string>;
	/** Branch to promote the tested commits to; blank or equal to the build branch means no promotion. */
	targetBranch?: string;
}

/** Whether a value can name a git branch (the characters `git check-ref-format` rejects, plus the `..`/leading-dash rules). */
export function isValidBranchName(value: string): boolean {
	if (!value || /[\s~^:?*[\\\x00-\x1f\x7f]/.test(value)) return false;
	if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) return false;
	return !value.includes('..') && !value.includes('@{') && !value.includes('//') && !value.includes('/.');
}
