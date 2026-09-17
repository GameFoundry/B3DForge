import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { collectDeploymentInputs } from '../src/deployment-inputs.js';
import { resolveWorkspace, WorkspaceLocks } from '../src/workspace.js';

async function tempDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('collectDeploymentInputs records every file of the deploy directory with its hash', async () => {
	const buildDir = await tempDir('forge-inputs-');
	try {
		const deployDir = path.join(buildDir, 'deploy');
		await fs.mkdir(path.join(deployDir, 'dependencies'), { recursive: true });
		const script = '#!/bin/bash\necho deploy\n';
		const archive = Buffer.from('not really a tarball');
		await fs.writeFile(path.join(deployDir, 'deploy.sh'), script);
		await fs.writeFile(path.join(deployDir, 'dependencies', 'XShaderCompiler_Win32_12.tar.gz'), archive);

		const inputs = await collectDeploymentInputs(buildDir);
		assert.ok(inputs);
		assert.deepEqual(inputs.files, [
			{ path: 'dependencies/XShaderCompiler_Win32_12.tar.gz', size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') },
			{ path: 'deploy.sh', size: Buffer.byteLength(script), sha256: createHash('sha256').update(script).digest('hex') },
		]);
	} finally {
		await fs.rm(buildDir, { recursive: true, force: true });
	}
});

test('collectDeploymentInputs returns null for builds that left no deploy files', async () => {
	const buildDir = await tempDir('forge-inputs-');
	try {
		assert.equal(await collectDeploymentInputs(buildDir), null);
	} finally {
		await fs.rm(buildDir, { recursive: true, force: true });
	}
});

test('resolveWorkspace moves a legacy single-platform checkout under the host platform', async () => {
	const root = await tempDir('forge-ws-');
	try {
		const legacy = path.join(root, 'editor', 'cfg');
		await fs.mkdir(path.join(legacy, '.git'), { recursive: true });
		await fs.writeFile(path.join(legacy, 'README'), 'checkout');

		const hostWorkspace = await resolveWorkspace(root, 'editor', 'cfg', process.platform);
		assert.equal(hostWorkspace, path.join(legacy, process.platform));
		assert.equal(await fs.readFile(path.join(hostWorkspace, 'README'), 'utf-8'), 'checkout');
		await assert.rejects(fs.access(path.join(legacy, '.git')));

		// A different target platform gets its own directory and leaves the host's alone.
		const ps5Workspace = await resolveWorkspace(root, 'editor', 'cfg', 'ps5');
		assert.equal(ps5Workspace, path.join(legacy, 'ps5'));
		assert.equal(await fs.readFile(path.join(hostWorkspace, 'README'), 'utf-8'), 'checkout');

		// Idempotent once migrated.
		assert.equal(await resolveWorkspace(root, 'editor', 'cfg', process.platform), hostWorkspace);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('resolveWorkspace migrates a legacy checkout even when the first build targets another platform', async () => {
	const root = await tempDir('forge-ws-');
	try {
		const legacy = path.join(root, 'editor', 'cfg');
		await fs.mkdir(path.join(legacy, '.git'), { recursive: true });
		const ps5Workspace = await resolveWorkspace(root, 'editor', 'cfg', 'ps5');
		assert.equal(ps5Workspace, path.join(legacy, 'ps5'));
		await fs.access(path.join(legacy, process.platform, '.git'));
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('WorkspaceLocks serialize builds sharing a workspace and release in order', async () => {
	const workspace = path.join(os.tmpdir(), 'forge-lock-test', 'ws');
	const order: string[] = [];

	const releaseA = await WorkspaceLocks.acquire(workspace);
	assert.equal(WorkspaceLocks.isHeld(workspace), true);
	const b = WorkspaceLocks.acquire(workspace).then(release => { order.push('b'); return release; });
	const c = WorkspaceLocks.acquire(workspace).then(release => { order.push('c'); return release; });

	await new Promise(resolve => setTimeout(resolve, 10));
	assert.deepEqual(order, []);

	releaseA();
	releaseA(); // a second release must not grant the lock twice
	const releaseB = await b;
	assert.deepEqual(order, ['b']);
	releaseB();
	const releaseC = await c;
	assert.deepEqual(order, ['b', 'c']);
	releaseC();
	assert.equal(WorkspaceLocks.isHeld(workspace), false);
});
