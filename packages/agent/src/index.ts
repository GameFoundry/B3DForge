#!/usr/bin/env node
import type { BuildAssignment, BuildCancelEvent } from '@banshee-forge/shared';
import { AgentConfig, loadConfig } from './config.js';
import { OrchestratorClient } from './orchestrator-client.js';
import { BuildExecutor } from './build-executor.js';
import { WorkspaceCleanup } from './workspace-cleanup.js';
import { ArtifactStore } from './artifact-store.js';
import { uploadResults } from './results-uploader.js';
import { AvailabilityMonitor } from './availability.js';
import { SleepInhibitor } from './power.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
	const config = await loadConfig();
	console.log(`BansheeForge agent starting`);
	console.log(`  Orchestrator: ${config.orchestratorUrl}`);
	console.log(`  Name:         ${config.name}`);
	console.log(`  Host:         ${config.platform}/${config.arch}`);
	console.log(`  Platforms:    ${config.platforms.join(', ')}`);
	console.log(`  Labels:       ${config.labels.join(', ') || '(none)'}`);
	console.log(`  Concurrency:  ${config.maxParallelBuilds}`);
	console.log(`  Workspace:    ${config.workspaceRoot}`);
	console.log(`  Builds:       ${config.buildsRoot}`);

	const client = new OrchestratorClient(config.orchestratorUrl, config.token);
	const activeExecutors = new Map<string, BuildExecutor>();

	// Availability gating (macOS: only while this user owns the console) and a sleep assertion
	// while builds run. Both feed the status heartbeat the dispatcher matches against.
	const availability = new AvailabilityMonitor();
	const sleepInhibitor = new SleepInhibitor();
	const sendStatus = () => {
		// Hold the sleep assertion exactly while builds are active (including result upload).
		if (activeExecutors.size > 0) sleepInhibitor.acquire();
		else sleepInhibitor.release();

		if (!client.isRegistered) return;
		const { available, reason } = availability.value;
		client.sendStatus({
			activeBuildIds: Array.from(activeExecutors.keys()),
			available,
			...(available ? {} : { unavailableReason: reason }),
		});
	};
	availability.on('changed', ({ available, reason }) => {
		console.log(available ? 'Agent available' : `Agent unavailable: ${reason}`);
		sendStatus();
	});
	availability.start();

	const cleanup = new WorkspaceCleanup({ workspaceRoot: config.workspaceRoot });
	setInterval(() => {
		cleanup.cleanupAll().catch(err => console.error('Cleanup failed:', err));
	}, 60 * 60 * 1000).unref();

	// Artifact maintenance, driven on demand from the orchestrator UI. Running builds are excluded
	// via a predicate over the live executor map, so a build assigned partway through a purge is
	// still protected — a snapshot taken up front would not cover it.
	const artifacts = new ArtifactStore(config.buildsRoot);
	const isBuildActive = (buildId: string) => activeExecutors.has(buildId);
	client.onMaintenanceRequest('maintenance:artifact-usage', () => artifacts.measure(isBuildActive));
	client.onMaintenanceRequest('maintenance:purge-artifacts', async () => {
		console.log('Purging build artifacts on orchestrator request');
		const result = await artifacts.purge(isBuildActive);
		const gib = (result.freedBytes / 1024 ** 3).toFixed(2);
		console.log(`Purged ${result.deletedCount} artifact director${result.deletedCount === 1 ? 'y' : 'ies'} (${gib} GiB)`);
		return result;
	});

	client.on('connect', () => {
		console.log('Connected to orchestrator');
		client.register({
			name: config.name,
			platform: config.platform,
			arch: config.arch,
			hostname: config.hostname,
			platforms: config.platforms,
			labels: config.labels,
			maxParallelBuilds: config.maxParallelBuilds,
			version: VERSION,
		});
	});

	client.on('register-ack', (response) => {
		if (response.ok) {
			console.log(`Registered (agentId=${response.agentId})`);
			client.markRegistered();
			// Report availability straight away so an unavailable agent never receives work.
			sendStatus();
		} else {
			console.error(`Registration rejected: ${response.error}`);
			process.exit(1);
		}
	});

	client.on('disconnect', (reason) => {
		const active = Array.from(activeExecutors.keys());
		const context = active.length ? ` (active builds: ${active.join(', ')})` : '';
		console.warn(`Disconnected from orchestrator: ${reason}${context}`);
	});

	client.on('connect_error', (err) => {
		console.error(`Orchestrator connection error: ${err.message}`);
	});

	client.on('build:assign', (assignment) => {
		runBuild(assignment, config, client, activeExecutors, sendStatus).catch(err => {
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
	setInterval(sendStatus, 10_000).unref();

	// Graceful shutdown.
	const shutdown = (signal: string) => {
		console.log(`Received ${signal}, shutting down`);
		for (const executor of activeExecutors.values()) executor.kill();
		availability.stop();
		sleepInhibitor.release();
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
	sendStatus: () => void,
): Promise<void> {
	const buildId = assignment.build.id;
	console.log(`Starting build ${buildId} (${assignment.project.slug})`);

	const executor = new BuildExecutor({
		workspaceRoot: config.workspaceRoot,
		buildsRoot: config.buildsRoot,
		scriptsRoot: config.scriptsRoot,
		defaultTimeoutMs: config.defaultTimeoutMs,
		logBufferIntervalMs: 100,
	});
	activeExecutors.set(buildId, executor);
	sendStatus();

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
				snapshotCategories: executor.getSnapshotCategories(),
			});
			activeExecutors.delete(buildId);
			sendStatus();
			console.log(`Build ${buildId} ${status} (exit ${exitCode})`);
		};
		finalize().catch(err => console.error(`Finalize failed for build ${buildId}:`, err));
	});
	executor.on('error', (code, message) => {
		client.sendError({ buildId, code, message });
		activeExecutors.delete(buildId);
		sendStatus();
		console.error(`Build ${buildId} error [${code}]: ${message}`);
	});

	try {
		await executor.execute(assignment);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		client.sendError({ buildId, code: 'EXECUTION_FAILED', message });
		activeExecutors.delete(buildId);
		sendStatus();
	}
}

main().catch(err => {
	console.error('Fatal:', err);
	process.exit(1);
});
