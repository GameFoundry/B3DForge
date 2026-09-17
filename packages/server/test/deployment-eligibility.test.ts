import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { EventEmitter } from 'events';
import type { Build, Project } from '@banshee-forge/shared';
import { DeploymentService, resolveDeployParameters } from '../src/services/deployment-service.js';
import { DeploymentRepository } from '../src/repositories/deployment-repository.js';
import { JsonFileStorage } from '../src/storage/json-file.js';
import { makeTempDir } from './helpers/git-fixture.js';

let root: string;
let service: DeploymentService;
let deployments: DeploymentRepository;

const project: Project = {
	id: 'p1',
	name: 'Editor',
	slug: 'editor',
	gitUrl: 'u',
	gitBranch: 'staging',
	deployBranch: 'master',
	configurations: [{
		id: 'cfg',
		name: 'Default',
		buildScript: { source: 'local' },
		testScript: { source: 'local' },
		configSchema: {},
		defaultConfig: {},
		deploySchema: {
			FRAMEWORK_VERSION: { type: 'string', pattern: '^v\\d+\\.\\d+\\.\\d+$', label: 'Framework version' },
			PUBLISH: { type: 'boolean', default: true },
		},
		createdAt: '',
		updatedAt: '',
	}],
	autoBuild: false,
	pollInterval: 300,
	createdAt: '',
	updatedAt: '',
} as unknown as Project;

const deployFiles = [
	{ path: 'deploy.sh', size: 10, sha256: 'b'.repeat(64) },
	{ path: 'dependencies/X_Win32_1.tar.gz', size: 100, sha256: 'c'.repeat(64) },
];

function goodBuild(overrides: Partial<Build> = {}): Build {
	return {
		id: 'build-1',
		projectSlug: 'editor',
		buildNumber: 1,
		configurationId: 'cfg',
		platform: 'win32',
		status: 'success',
		triggerType: 'manual',
		gitBranch: 'staging',
		gitCommit: 'a'.repeat(40),
		config: { runTests: true },
		createdAt: '',
		deploymentInputs: { files: deployFiles },
		testResultsComplete: true,
		resultsUploadComplete: true,
		testSummary: { total: 10, passed: 10, failed: 0, skipped: 0 },
		agentName: 'agent-1',
		...overrides,
	} as unknown as Build;
}

before(async () => {
	root = await makeTempDir('forge-eligibility-');
	deployments = new DeploymentRepository(new JsonFileStorage(root));
	// Eligibility only consults the deployment repository; every other collaborator is inert.
	const registry = new EventEmitter();
	service = new DeploymentService(
		{ emit: () => true, to: () => ({ emit: () => true }) } as never,
		deployments,
		// Scheduled deployments look their build up first; "not found" settles them as failed without touching anything else.
		{ findById: async () => null } as never,
		{} as never,
		{ findAll: async () => [project], findBySlug: async () => project } as never,
		registry as never,
		{} as never,
		{} as never,
	);
});

after(async () => {
	// createDeployment queues a run that settles the deployment as failed (no build); let it finish
	// before the directory it writes to disappears.
	await service.settled();
	await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

test('a successful, fully tested build with deploy files is eligible', async () => {
	const result = await service.checkEligibility(goodBuild(), project);
	assert.deepEqual(result.reasons, []);
	assert.equal(result.eligible, true);
	assert.equal(result.defaultTargetBranch, 'master');
	assert.equal(result.buildBranch, 'staging');
});

test('the target branch defaults to the project deploy branch; blank or the build branch means no promotion', async () => {
	const created = await service.createDeployment(goodBuild({ id: 'build-target' }), project, {}, 'manual', 'me', 'build');
	assert.equal(created.targetBranch, 'master');
	assert.equal(created.rootCommit, 'a'.repeat(40));
	assert.deepEqual(created.files, deployFiles);
	assert.deepEqual(created.parameters, { FRAMEWORK_VERSION: '', PUBLISH: 'true' });

	const custom = await service.createDeployment(goodBuild({ id: 'build-target-2' }), project, { targetBranch: ' release/2.0 ' }, 'manual', 'me', 'build');
	assert.equal(custom.targetBranch, 'release/2.0');

	const none = await service.createDeployment(goodBuild({ id: 'build-target-3' }), project, { targetBranch: '' }, 'manual', 'me', 'build');
	assert.equal(none.targetBranch, undefined);
	const same = await service.createDeployment(goodBuild({ id: 'build-target-4' }), project, { targetBranch: 'staging' }, 'manual', 'me', 'build');
	assert.equal(same.targetBranch, undefined);

	await assert.rejects(service.createDeployment(goodBuild({ id: 'build-target-5' }), project, { targetBranch: 'bad branch' }, 'manual', 'me', 'build'), /not a valid branch name/);
});

test('deploy parameters are validated against the configuration schema', async () => {
	const schema = project.configurations[0].deploySchema!;
	assert.deepEqual(resolveDeployParameters(schema, { FRAMEWORK_VERSION: ' v1.2.3 ', PUBLISH: 'false', UNKNOWN: 'x' }), { FRAMEWORK_VERSION: 'v1.2.3', PUBLISH: 'false' });
	assert.throws(() => resolveDeployParameters(schema, { FRAMEWORK_VERSION: '1.2.3' }), /must match/);
	assert.throws(() => resolveDeployParameters({ NAME: { type: 'string', required: true } }, {}), /is required/);
	assert.throws(() => resolveDeployParameters({ KIND: { type: 'select', options: ['a', 'b'] } }, { KIND: 'c' }), /must be one of/);

	const created = await service.createDeployment(goodBuild({ id: 'build-params' }), project, { parameters: { FRAMEWORK_VERSION: 'v2.0.0' } }, 'manual', 'me', 'build');
	assert.deepEqual(created.parameters, { FRAMEWORK_VERSION: 'v2.0.0', PUBLISH: 'true' });
});

test('failed tests, missing results or a failed build block deployment', async () => {
	assert.equal((await service.checkEligibility(goodBuild({ status: 'failed' }), project)).eligible, false);
	assert.equal((await service.checkEligibility(goodBuild({ status: 'running' }), project)).reasons[0], 'Build has not finished');
	assert.match((await service.checkEligibility(goodBuild({ testSummary: { total: 10, passed: 9, failed: 1, skipped: 0 } }), project)).reasons[0], /1 test\(s\) failed/);
	assert.match((await service.checkEligibility(goodBuild({ testResultsComplete: false }), project)).reasons[0], /not ingested/);
	assert.match((await service.checkEligibility(goodBuild({ resultsUploadComplete: false }), project)).reasons[0], /failed to upload/);
	assert.match((await service.checkEligibility(goodBuild({ testSummary: { total: 0, passed: 0, failed: 0, skipped: 0 } }), project)).reasons[0], /No test results/);
	assert.match((await service.checkEligibility(goodBuild({ config: { runTests: false } }), project)).reasons[0], /Tests were not run/);
});

test('builds without deploy files, without deploy.sh or with purged files need a new build', async () => {
	assert.match((await service.checkEligibility(goodBuild({ deploymentInputs: undefined }), project)).reasons[0], /no deploy files/);
	assert.match((await service.checkEligibility(goodBuild({ deploymentInputs: { files: [deployFiles[1]] } }), project)).reasons[0], /no deploy.sh/);
	const purged = goodBuild({ deploymentInputs: { files: deployFiles, purged: true } });
	assert.match((await service.checkEligibility(purged, project)).reasons[0], /purged on agent agent-1/);
});

test('an in-flight deployment of the same build blocks a second one', async () => {
	await deployments.save({
		id: 'deploy-x',
		projectSlug: 'editor',
		buildId: 'build-1',
		buildNumber: 1,
		platform: 'win32',
		configurationId: 'cfg',
		rootCommit: 'a'.repeat(40),
		buildBranch: 'staging',
		status: 'transferring',
		triggerType: 'manual',
		parameters: {},
		promotionScope: 'build',
		phases: [],
		files: deployFiles,
		artifacts: [],
		results: [],
		agentName: 'agent-1',
		attempt: 1,
		createdAt: new Date().toISOString(),
	});
	const result = await service.checkEligibility(goodBuild(), project);
	assert.deepEqual(result.reasons, ['A deployment of this build is already in progress']);
	assert.equal(result.deployments.length, 1);

	await deployments.save({ ...(await deployments.findById('editor', 'deploy-x'))!, status: 'failed' });
	assert.equal((await service.checkEligibility(goodBuild(), project)).eligible, true);
});

test('uploads are accepted only for recorded paths from the assigned agent while transferring', async () => {
	const deployment = (await deployments.findById('editor', 'deploy-x'))!;
	await deployments.save({ ...deployment, status: 'transferring', agentTokenId: 'tok' });
	const current = (await deployments.findById('editor', 'deploy-x'))!;
	await assert.rejects(service.authorizeUpload(current, 'other', 'deploy.sh'), /not from the agent/);
	await assert.rejects(service.authorizeUpload(current, 'tok', '../deploy.sh'), /Invalid relative path/);
	await assert.rejects(service.authorizeUpload(current, 'tok', 'extra.txt'), /not one of the build's recorded deploy files/);
	const target = await service.authorizeUpload(current, 'tok', 'dependencies/X_Win32_1.tar.gz');
	assert.ok(target.endsWith('X_Win32_1.tar.gz'));
	await deployments.save({ ...current, status: 'failed' });
});
