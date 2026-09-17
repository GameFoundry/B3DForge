import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import { SubmodulePinService, PinUpdateError } from '../src/services/submodule-pin-service.js';
import { PromotionService, PromotionError } from '../src/services/promotion-service.js';
import { DeploymentRepository } from '../src/repositories/deployment-repository.js';
import { JsonFileStorage } from '../src/storage/json-file.js';
import { Repo, makeTempDir } from './helpers/git-fixture.js';

/**
 * End-to-end exercise of the submodule pin and promotion services against real git
 * repositories: a parent ("editor") with a submodule ("framework") that has a submodule of its
 * own ("examples"). Every repository has a `staging` branch that moved past `master`, while the
 * gitlinks still pin the `master` commits.
 */
let root: string;
let dataPath: string;
let parent: Repo;
let child: Repo;
let grandchild: Repo;
let grandchildMaster: string;
let grandchildStaging: string;
let childMaster: string;
let childStaging: string;
let parentStaging: string;
let pins: SubmodulePinService;
let deployments: DeploymentRepository;

const log = () => undefined;

before(async () => {
	root = await makeTempDir('forge-deploy-');
	dataPath = path.join(root, 'data');
	pins = new SubmodulePinService(dataPath);
	deployments = new DeploymentRepository(new JsonFileStorage(dataPath));

	grandchild = await Repo.create(root, 'examples');
	grandchildMaster = await grandchild.commitFile('README', 'examples v1\n', 'examples: initial');
	await grandchild.push('master');
	await grandchild.checkout('staging', true);
	grandchildStaging = await grandchild.commitFile('README', 'examples v2\n', 'examples: tested change');
	await grandchild.push('staging');

	child = await Repo.create(root, 'framework');
	await child.commitFile('README', 'framework v1\n', 'framework: initial');
	childMaster = await child.setGitlink('Examples', grandchildMaster, grandchild.url, 'master', 'framework: pin examples v1');
	await child.push('master');
	await child.checkout('staging', true);
	childStaging = await child.commitFile('README', 'framework v2\n', 'framework: tested change');
	await child.push('staging');

	parent = await Repo.create(root, 'editor');
	await parent.commitFile('README', 'editor v1\n', 'editor: initial');
	// The .gitmodules entry names a branch the child does not have; the build branch wins and
	// this declaration only matters as a fallback.
	await parent.setGitlink('Framework', childMaster, child.url, 'nonexistent', 'editor: pin framework v1');
	await parent.push('master');
	await parent.checkout('staging', true);
	parentStaging = await parent.commitFile('README', 'editor v2\n', 'editor: tested change');
	await parent.push('staging');
});

after(async () => {
	await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

test('inspect reports pins behind the heads of their branches, recursively', async () => {
	const inspection = await pins.inspect({ rootUrl: parent.url, branch: 'staging' });
	assert.equal(inspection.rootCommit, parentStaging);
	assert.equal(inspection.submodules.length, 2);

	const [framework, examples] = inspection.submodules;
	assert.equal(framework.path, 'Framework');
	assert.equal(framework.depth, 1);
	assert.equal(framework.pinned, childMaster);
	assert.equal(framework.branch, 'staging');
	assert.equal(framework.head, childStaging);
	assert.equal(framework.stale, true);

	// The grandchild is inspected at the child's staging head, the commit a build would use after an update.
	assert.equal(examples.path, 'Framework/Examples');
	assert.equal(examples.depth, 2);
	assert.equal(examples.pinned, grandchildMaster);
	assert.equal(examples.head, grandchildStaging);
	assert.equal(examples.stale, true);
});

test('inspect on master finds nothing stale, and a child without the branch falls back to .gitmodules', async () => {
	const onMaster = await pins.inspect({ rootUrl: parent.url, branch: 'master' });
	assert.ok(onMaster.submodules.every(s => !s.stale));

	// A root-only branch: the child lacks it and .gitmodules names a branch that does not exist
	// either, so the pin is not checked at all.
	await parent.checkout('feature/root-only', true);
	await parent.commitFile('FEATURE', 'x\n', 'editor: root-only branch');
	await parent.push('feature/root-only');
	const rootOnly = await pins.inspect({ rootUrl: parent.url, branch: 'feature/root-only' });
	assert.equal(rootOnly.submodules[0].branch, undefined);
	assert.equal(rootOnly.submodules[0].stale, false);
	await parent.checkout('staging');
});

test('updatePins refuses a branch that moved since it was inspected', async () => {
	await assert.rejects(
		pins.updatePins({ rootName: 'Editor', rootUrl: parent.url, branch: 'staging', expectedRootCommit: 'a'.repeat(40) }),
		(err: unknown) => err instanceof PinUpdateError && err.conflict,
	);
});

test('updatePins writes pin commits children first and pushes them without force', async () => {
	const result = await pins.updatePins({ rootName: 'Editor', rootUrl: parent.url, branch: 'staging', expectedRootCommit: parentStaging });

	assert.equal(result.updates.length, 2);
	const [frameworkUpdate, editorUpdate] = result.updates;
	assert.equal(frameworkUpdate.name, 'Framework');
	assert.equal(frameworkUpdate.from, childStaging);
	assert.deepEqual(frameworkUpdate.pins, { Examples: grandchildStaging });
	assert.equal(editorUpdate.path, '');
	assert.equal(editorUpdate.from, parentStaging);
	assert.deepEqual(editorUpdate.pins, { Framework: frameworkUpdate.to });
	assert.equal(result.rootCommit, editorUpdate.to);

	// The remotes moved by exactly one commit each, on top of their previous staging heads.
	assert.equal(await child.remoteHead('staging'), frameworkUpdate.to);
	assert.equal(await parent.remoteHead('staging'), result.rootCommit);
	assert.ok(await child.isAncestor(childStaging, frameworkUpdate.to));
	assert.ok(await parent.isAncestor(parentStaging, result.rootCommit));
	assert.equal(await child.gitlinkAt(frameworkUpdate.to, 'Examples'), grandchildStaging);
	assert.equal(await parent.gitlinkAt(result.rootCommit, 'Framework'), frameworkUpdate.to);
	// The grandchild has no submodules, so nothing was pushed to it.
	assert.equal(await grandchild.remoteHead('staging'), grandchildStaging);

	const again = await pins.inspect({ rootUrl: parent.url, branch: 'staging' });
	assert.equal(again.rootCommit, result.rootCommit);
	assert.ok(again.submodules.every(s => !s.stale));

	// Nothing stale: the update is a no-op that returns the same head.
	const noop = await pins.updatePins({ rootName: 'Editor', rootUrl: parent.url, branch: 'staging', expectedRootCommit: result.rootCommit });
	assert.equal(noop.rootCommit, result.rootCommit);
	assert.equal(noop.updates.length, 0);
});

test('resolveTree lists the commits a root commit pins, parents before children', async () => {
	const rootCommit = await parent.remoteHead('staging');
	const tree = await pins.resolveTree('Editor', parent.url, rootCommit);
	assert.deepEqual(tree.map(r => [r.path, r.depth]), [['', 0], ['Framework', 1], ['Framework/Examples', 2]]);
	assert.equal(tree[0].commit, rootCommit);
	assert.equal(tree[1].commit, await child.remoteHead('staging'));
	assert.equal(tree[2].commit, grandchildStaging);
	assert.equal(await pins.readFile(parent.url, rootCommit, 'Framework/Examples/README'), 'examples v2\n');
	assert.equal(await pins.readFile(parent.url, rootCommit, 'Framework/missing.txt'), null);
});

test('promotion fast-forwards master of every repository, children first, and is reused', async () => {
	const rootCommit = await parent.remoteHead('staging');
	const childTip = await child.remoteHead('staging');
	const promotion = new PromotionService(pins, deployments);
	const messages: string[] = [];

	const record = await promotion.promote({
		projectSlug: 'editor', deploymentId: 'deploy-1', rootName: 'Editor', rootUrl: parent.url,
		rootCommit, buildBranch: 'staging', targetBranch: 'master', log: m => messages.push(m),
	});
	assert.equal(record.status, 'complete');
	assert.deepEqual(record.repositories.map(r => [r.name, r.integration, r.pushed]), [
		['Examples', 'fast-forward', true], ['Framework', 'fast-forward', true], ['Editor', 'fast-forward', true],
	]);
	assert.equal(await grandchild.remoteHead('master'), grandchildStaging);
	assert.equal(await child.remoteHead('master'), childTip);
	assert.equal(await parent.remoteHead('master'), rootCommit);
	// Staging was not touched.
	assert.equal(await parent.remoteHead('staging'), rootCommit);

	// A second platform of the same commit reuses the journal instead of pushing again.
	const reused = await promotion.promote({
		projectSlug: 'editor', deploymentId: 'deploy-2', rootName: 'Editor', rootUrl: parent.url,
		rootCommit, buildBranch: 'staging', targetBranch: 'master', log,
	});
	assert.equal(reused.deploymentId, 'deploy-1');

	// A journal is per target branch: the same commit can still go to another branch.
	const release = await promotion.promote({
		projectSlug: 'editor', deploymentId: 'deploy-3', rootName: 'Editor', rootUrl: parent.url,
		rootCommit, buildBranch: 'staging', targetBranch: 'release/1.0', log,
	});
	assert.equal(release.deploymentId, 'deploy-3');
	assert.equal(release.repositories[2].previousTarget, '');
	assert.equal(await parent.remoteHead('release/1.0'), rootCommit);
});

test('a target that moved receives a merge commit; a target already containing the commit is unchanged', async () => {
	// A hotfix lands on master only.
	await parent.sync('master');
	const hotfix = await parent.commitFile('HOTFIX', 'fix\n', 'editor: hotfix on master');
	await parent.push('master');

	// Meanwhile staging gets a new tested commit.
	await parent.sync('staging');
	const tested = await parent.commitFile('README', 'editor v3\n', 'editor: next tested change');
	await parent.push('staging');

	const promotion = new PromotionService(pins, deployments);
	const record = await promotion.promote({
		projectSlug: 'editor', deploymentId: 'deploy-4', rootName: 'Editor', rootUrl: parent.url,
		rootCommit: tested, buildBranch: 'staging', targetBranch: 'master', log,
	});
	const editor = record.repositories.find(r => r.path === '')!;
	assert.equal(editor.integration, 'merge');
	assert.equal(editor.previousTarget, hotfix);
	const master = await parent.remoteHead('master');
	assert.equal(master, editor.newTarget);
	assert.ok(await parent.isAncestor(hotfix, master));
	assert.ok(await parent.isAncestor(tested, master));
	// The submodules did not change, so their targets already contained the tested commits.
	assert.ok(record.repositories.filter(r => r.path).every(r => r.integration === 'unchanged'));

	// Promoting the same commit to a branch that already merged it moves nothing.
	const nothing = await promotion.promote({
		projectSlug: 'editor', deploymentId: 'deploy-5', rootName: 'Editor', rootUrl: parent.url,
		rootCommit: tested, buildBranch: 'staging', targetBranch: 'release/1.0', log,
	});
	assert.equal(nothing.repositories.find(r => r.path === '')!.integration, 'fast-forward');
	const releaseTip = await parent.remoteHead('release/1.0');
	assert.equal(releaseTip, tested);
	const again = await promotion.promote({
		projectSlug: 'editor', deploymentId: 'deploy-6', rootName: 'Editor', rootUrl: parent.url,
		rootCommit: hotfix, buildBranch: 'master', targetBranch: 'release/1.0', log,
	});
	// The release branch does not contain the hotfix, so it is merged in; nothing is rolled back.
	assert.equal(again.repositories.find(r => r.path === '')!.integration, 'merge');
});

test('a conflicting merge fails the promotion and pushes nothing', async () => {
	await parent.sync('master');
	await parent.commitFile('CONFLICT', 'master says A\n', 'editor: conflicting change on master');
	await parent.push('master');
	const masterBefore = await parent.remoteHead('master');

	await parent.sync('staging');
	const tested = await parent.commitFile('CONFLICT', 'staging says B\n', 'editor: conflicting change on staging');
	await parent.push('staging');

	const promotion = new PromotionService(pins, deployments);
	await assert.rejects(
		promotion.promote({
			projectSlug: 'editor', deploymentId: 'deploy-7', rootName: 'Editor', rootUrl: parent.url,
			rootCommit: tested, buildBranch: 'staging', targetBranch: 'master', log,
		}),
		(err: unknown) => err instanceof PromotionError && /conflicts/.test(err.message),
	);
	assert.equal(await parent.remoteHead('master'), masterBefore);
	assert.equal(await deployments.findPromotion('editor', tested, 'master'), null);
});
