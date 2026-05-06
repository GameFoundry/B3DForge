#!/usr/bin/env node
import type { BuildAssignment, BuildCancelEvent } from '@banshee-forge/shared';
import { AgentConfig, loadConfig } from './config.js';
import { OrchestratorClient } from './orchestrator-client.js';
import { BuildExecutor } from './build-executor.js';
import { WorkspaceCleanup } from './workspace-cleanup.js';
import { uploadResults } from './results-uploader.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
	const config = await loadConfig();
	console.log(`BansheeForge agent starting`);
	console.log(`  Orchestrator: ${config.orchestratorUrl}`);
	console.log(`  Name:         ${config.name}`);
	console.log(`  Platform:     ${config.platform}/${config.arch}`);
	console.log(`  Labels:       ${config.labels.join(', ') || '(none)'}`);
	console.log(`  Concurrency:  ${config.maxParallelBuilds}`);
	console.log(`  Workspace:    ${config.workspaceRoot}`);

	const client = new OrchestratorClient(config.orchestratorUrl, config.token);
	const activeExecutors = new Map<string, BuildExecutor>();

	const cleanup = new WorkspaceCleanup({ workspaceRoot: config.workspaceRoot });
	setInterval(() => {
		cleanup.cleanupAll().catch(err => console.error('Cleanup failed:', err));
	}, 60 * 60 * 1000).unref();

	client.on('connect', () => {
		console.log('Connected to orchestrator');
		client.register({
			name: config.name,
			platform: config.platform,
			arch: config.arch,
			hostname: config.hostname,
			labels: config.labels,
			maxParallelBuilds: config.maxParallelBuilds,
			version: VERSION,
		});
	});

	client.on('register-ack', (response) => {
		if (response.ok) {
			console.log(`Registered (agentId=${response.agentId})`);
			client.markRegistered();
		} else {
			console.error(`Registration rejected: ${response.error}`);
			process.exit(1);
		}
	});

	client.on('disconnect', (reason) => {
		console.warn(`Disconnected from orchestrator: ${reason}`);
	});

	client.on('build:assign', (assignment) => {
		runBuild(assignment, config, client, activeExecutors).catch(err => {
			console.error(`Build ${assignment.build.id} crashed:`, err);
		});
	});

	client.on('build:cancel', (payload: BuildCancelEvent) => {
		const executor = activeExecutors.get(payload.buildId);
		if (executor) {
			console.log(`Cancelling build ${payload.buildId}`);
			executor.kill();
		}
	});

	// Periodic heartbeat so the orchestrator notices missed updates.
	setInterval(() => {
		if (client.isRegistered) {
			client.sendStatus({ activeBuildIds: Array.from(activeExecutors.keys()) });
		}
	}, 10_000).unref();

	// Graceful shutdown.
	const shutdown = (signal: string) => {
		console.log(`Received ${signal}, shutting down`);
		for (const executor of activeExecutors.values()) executor.kill();
		client.disconnect();
		setTimeout(() => process.exit(0), 1000).unref();
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function runBuild(
	assignment: BuildAssignment,
	config: AgentConfig,
	client: OrchestratorClient,
	activeExecutors: Map<string, BuildExecutor>,
): Promise<void> {
	const buildId = assignment.build.id;
	console.log(`Starting build ${buildId} (${assignment.project.slug})`);

	const executor = new BuildExecutor({
		workspaceRoot: config.workspaceRoot,
		scriptsRoot: config.scriptsRoot,
		defaultTimeoutMs: config.defaultTimeoutMs,
		logBufferIntervalMs: 100,
	});
	activeExecutors.set(buildId, executor);
	client.sendStatus({ activeBuildIds: Array.from(activeExecutors.keys()) });

	executor.on('log', (lines) => {
		client.sendLog({ buildId, lines });
	});
	executor.on('phase:start', (phase) => {
		client.sendPhase({ buildId, phase, action: 'start' });
	});
	executor.on('phase:end', (phase) => {
		client.sendPhase({ buildId, phase, action: 'end' });
	});
	executor.on('complete', (status, exitCode) => {
		// Upload test results before signalling completion so the orchestrator
		// can parse them when handling agent:complete.
		const resultsDir = executor.getResultsDir();
		const finalize = async () => {
			if (resultsDir) {
				try {
					const summary = await uploadResults({
						orchestratorUrl: config.orchestratorUrl,
						token: config.token,
						projectSlug: assignment.project.slug,
						buildId,
						resultsDir,
					});
					if (summary.uploaded + summary.failed + summary.skipped > 0) {
						console.log(`[results-upload] build ${buildId}: uploaded=${summary.uploaded} failed=${summary.failed} skipped=${summary.skipped}`);
					}
				} catch (err) {
					console.warn(`[results-upload] build ${buildId} aborted:`, err);
				}
			}

			client.sendComplete({
				buildId,
				status,
				exitCode,
				repositoryCommits: executor.getRepositoryCommits(),
			});
			activeExecutors.delete(buildId);
			client.sendStatus({ activeBuildIds: Array.from(activeExecutors.keys()) });
			console.log(`Build ${buildId} ${status} (exit ${exitCode})`);
		};
		finalize().catch(err => console.error(`Finalize failed for build ${buildId}:`, err));
	});
	executor.on('error', (code, message) => {
		client.sendError({ buildId, code, message });
		activeExecutors.delete(buildId);
		client.sendStatus({ activeBuildIds: Array.from(activeExecutors.keys()) });
		console.error(`Build ${buildId} error [${code}]: ${message}`);
	});

	try {
		await executor.execute(assignment);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		client.sendError({ buildId, code: 'EXECUTION_FAILED', message });
		activeExecutors.delete(buildId);
		client.sendStatus({ activeBuildIds: Array.from(activeExecutors.keys()) });
	}
}

main().catch(err => {
	console.error('Fatal:', err);
	process.exit(1);
});
