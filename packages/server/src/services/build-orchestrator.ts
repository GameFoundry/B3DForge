import { Server as SocketServer } from 'socket.io';
import path from 'path';
import { promises as fs } from 'fs';
import type {
	Build,
	BuildPhase,
	BuildStatus,
	BuildSummary,
	LogLine,
	QueueStatus,
	RepositoryCommitInfo,
	AgentLogEvent,
	AgentPhaseEvent,
	AgentCompleteEvent,
	AgentErrorEvent,
} from '@banshee-forge/shared';
import { BuildQueue } from './build-queue.js';
import { TestResultsService } from './test-results-service.js';
import { BuildRepository } from '../repositories/build-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';

/** Subset of the dispatcher used by the orchestrator. Defined inline to avoid a circular import. */
interface DispatcherDelegate {
	cancel(buildId: string): boolean;
}

export interface OrchestratorConfig {
	dataPath: string;
}

/**
 * Tracks build lifecycle state on the orchestrator side. Build execution itself happens on
 * an agent — this class is responsible for queuing, persistence, web-side socket fan-out,
 * and end-of-build summarisation. The `onAgentX` methods are invoked by the agent namespace
 * (via `AgentDispatcher`) when an agent reports back.
 */
export class BuildOrchestrator {
	private queue: BuildQueue;
	/** Per-build accumulators while a build is running on an agent. */
	private liveState: Map<string, BuildLiveState> = new Map();
	private dataPath: string;
	private dispatcher: DispatcherDelegate | null = null;

	constructor(
		private io: SocketServer,
		private buildRepo: BuildRepository,
		private projectRepo: ProjectRepository,
		private testResultsService: TestResultsService | null,
		config: OrchestratorConfig,
	) {
		this.dataPath = config.dataPath;
		this.queue = new BuildQueue();
		this.queue.on('queue:updated', (status) => this.io.emit('queue:updated', status));
	}

	getQueue(): BuildQueue {
		return this.queue;
	}

	/** Wired after construction to break the orchestrator ↔ dispatcher circular dependency. */
	setDispatcher(dispatcher: DispatcherDelegate): void {
		this.dispatcher = dispatcher;
	}

	async initialize(): Promise<void> {
		await this.recoverBuilds();
	}

	async triggerBuild(projectSlug: string, buildId: string, priority = 0): Promise<void> {
		this.queue.enqueue(buildId, projectSlug, priority);
	}

	cancelBuild(buildId: string): boolean {
		if (!this.dispatcher) return this.queue.dequeue(buildId);
		return this.dispatcher.cancel(buildId);
	}

	getQueueStatus(): QueueStatus {
		return this.queue.getStatus();
	}

	hasActiveBuilds(projectSlug: string): boolean {
		const status = this.queue.getStatus();
		if (status.queue.some(job => job.projectSlug === projectSlug)) return true;
		for (const state of this.liveState.values()) {
			if (state.projectSlug === projectSlug) return true;
		}
		return false;
	}

	/* ─────────── agent → orchestrator event handlers ─────────── */

	async onBuildAssigned(buildId: string, projectSlug: string, agentId: string, agentName: string): Promise<void> {
		this.liveState.set(buildId, {
			buildId,
			projectSlug,
			agentId,
			agentName,
			startedAt: new Date().toISOString(),
			phases: [],
			warningCount: 0,
			errorCount: 0,
			pendingPhasePersistence: [],
		});

		await this.buildRepo.updateStatus(projectSlug, buildId, 'running');
		this.emitBuildStatus(buildId, 'running');

		const build = await this.buildRepo.findById(projectSlug, buildId);
		const project = await this.projectRepo.findBySlug(projectSlug);
		if (build && project && (build.triggerType === 'auto' || build.triggerType === 'webhook')) {
			this.io.emit('build:started', {
				buildId,
				projectSlug,
				projectName: project.name,
				buildNumber: build.buildNumber,
				triggerType: build.triggerType,
				configurationName: build.configurationName,
				agentId,
				agentName,
			});
		}
	}

	async onAgentLog(event: AgentLogEvent): Promise<void> {
		const state = this.liveState.get(event.buildId);
		if (!state) return;

		try {
			const logText = event.lines.map(l => l.message).join('\n') + '\n';
			await this.buildRepo.appendLog(state.projectSlug, event.buildId, logText);
			this.io.to(`build:${event.buildId}`).emit('build:log', {
				buildId: event.buildId,
				lines: event.lines,
			});
			this.updateCounts(state, event.lines);
			this.io.to(`build:${event.buildId}`).emit('build:stats', {
				buildId: event.buildId,
				warningCount: state.warningCount,
				errorCount: state.errorCount,
			});
		} catch (err) {
			console.error(`Error in log handler for build ${event.buildId}:`, err);
		}
	}

	async onAgentPhase(event: AgentPhaseEvent): Promise<void> {
		const state = this.liveState.get(event.buildId);
		if (!state) return;

		const persist = (async () => {
			try {
				this.io.to(`build:${event.buildId}`).emit('build:phase', {
					buildId: event.buildId,
					phase: event.phase,
					action: event.action,
				});

				if (event.action === 'start') {
					state.phases.push(event.phase);
				} else {
					const idx = state.phases.findIndex(p => p.name === event.phase.name && p.status === 'running');
					if (idx !== -1) state.phases[idx] = event.phase;
					else state.phases.push(event.phase);
				}

				await this.buildRepo.update(state.projectSlug, event.buildId, { phases: state.phases });
			} catch (err) {
				console.error(`Error in phase handler for build ${event.buildId}:`, err);
			}
		})();
		state.pendingPhasePersistence.push(persist);
	}

	async onAgentComplete(event: AgentCompleteEvent): Promise<void> {
		const state = this.liveState.get(event.buildId);
		if (!state) return;

		try {
			await Promise.allSettled(state.pendingPhasePersistence);

			const finalStatus: BuildStatus = event.status === 'success' ? 'success' : 'failed';

			const build = await this.buildRepo.findById(state.projectSlug, event.buildId);

			let testSummary;
			if (this.testResultsService) {
				try {
					const resultsDir = path.join(
						this.dataPath, 'projects', state.projectSlug, 'builds', event.buildId, 'results',
					);
					const testResults = await this.testResultsService.parseAndStoreResults(
						state.projectSlug, event.buildId, resultsDir,
					);
					testSummary = this.testResultsService.computeTestSummary(testResults);
					this.io.to(`build:${event.buildId}`).emit('test_results', {
						buildId: event.buildId,
						summary: testSummary,
					});
				} catch (parseErr) {
					console.log(`No test results found for build ${event.buildId}:`, parseErr);
				}
			}

			const finishedAt = new Date().toISOString();
			const durationMs = build?.startedAt
				? new Date(finishedAt).getTime() - new Date(build.startedAt).getTime()
				: undefined;

			await this.buildRepo.update(state.projectSlug, event.buildId, {
				status: finalStatus,
				phases: state.phases,
				warningCount: state.warningCount,
				errorCount: state.errorCount,
				repositoryCommits: event.repositoryCommits,
				finishedAt,
				durationMs,
				testSummary,
			});

			this.io.to(`build:${event.buildId}`).emit('build:complete', {
				buildId: event.buildId,
				status: finalStatus,
				summary: {
					durationMs: durationMs ?? 0,
					warningCount: state.warningCount,
					errorCount: state.errorCount,
					phases: state.phases,
					testSummary,
				},
			});

			this.io.emit('builds:updated');

			const project = await this.projectRepo.findBySlug(state.projectSlug);
			if (build && project) {
				this.io.emit('build:finished', {
					buildId: event.buildId,
					projectSlug: state.projectSlug,
					projectName: project.name,
					buildNumber: build.buildNumber,
					triggerType: build.triggerType,
					configurationName: build.configurationName,
					status: finalStatus,
					durationMs,
					warningCount: state.warningCount,
					errorCount: state.errorCount,
					testSummary,
					agentId: state.agentId,
					agentName: state.agentName,
				});
			}
		} catch (err) {
			console.error(`Error in complete handler for build ${event.buildId}:`, err);
			try {
				await this.buildRepo.updateStatus(state.projectSlug, event.buildId, 'failed');
				this.io.to(`build:${event.buildId}`).emit('build:complete', {
					buildId: event.buildId,
					status: 'failed',
				});
				this.io.emit('builds:updated');
			} catch (updateErr) {
				console.error(`Failed to update build status for ${event.buildId}:`, updateErr);
			}
		} finally {
			this.liveState.delete(event.buildId);
		}
	}

	async onAgentError(event: AgentErrorEvent, projectSlug: string | null, _agentId: string | null): Promise<void> {
		const state = this.liveState.get(event.buildId);
		const slug = state?.projectSlug ?? projectSlug ?? null;
		try {
			console.error(`Build ${event.buildId} error [${event.code}]:`, event.message);
			if (slug) {
				await this.buildRepo.appendLog(slug, event.buildId, `\n[ERROR: ${event.code}] ${event.message}\n`).catch(() => undefined);
				await this.buildRepo.updateStatus(slug, event.buildId, 'failed').catch(() => undefined);
			}
			this.io.to(`build:${event.buildId}`).emit('build:error', {
				buildId: event.buildId,
				code: event.code,
				message: event.message,
			});
			this.emitBuildStatus(event.buildId, 'failed');
		} finally {
			this.liveState.delete(event.buildId);
		}
	}

	/* ─────────── recovery and helpers ─────────── */

	private async recoverBuilds(): Promise<void> {
		const projects = await this.projectRepo.findAll();

		this.queue.pause();

		for (const project of projects) {
			await this.repairBuildsIndex(project.slug);

			const { builds } = await this.buildRepo.findAllForProject(project.slug, 1, 1000);

			for (const build of builds) {
				if (build.status === 'running') {
					await this.buildRepo.updateStatus(project.slug, build.id, 'failed');
					await this.buildRepo.appendLog(
						project.slug,
						build.id,
						'\n\n[Build interrupted: Server was restarted]\n',
					);
				} else if (build.status === 'pending') {
					this.queue.addToQueueSilent({
						buildId: build.id,
						projectSlug: project.slug,
						priority: 0,
						queuedAt: build.startedAt ?? new Date().toISOString(),
					});
				}
			}
		}

		this.queue.resume();
	}

	private async repairBuildsIndex(projectSlug: string): Promise<void> {
		const buildsPath = path.join(this.dataPath, 'builds', projectSlug, 'builds.json');
		let indexData: { builds: BuildSummary[]; nextBuildNumber: number };
		try {
			const content = await fs.readFile(buildsPath, 'utf-8');
			indexData = JSON.parse(content);
		} catch {
			indexData = { builds: [], nextBuildNumber: 1 };
		}

		const indexMap = new Map(indexData.builds.map(b => [b.id, b]));
		const buildIds = await this.listBuildDirectories(projectSlug);
		let repaired = 0;
		let maxBuildNumber = indexData.nextBuildNumber - 1;

		for (const buildId of buildIds) {
			let build = await this.buildRepo.findById(projectSlug, buildId);
			if (!build) continue;

			const phasesRepaired = await this.repairBuildPhases(projectSlug, build);
			if (phasesRepaired) {
				build = await this.buildRepo.findById(projectSlug, buildId);
				if (!build) continue;
				repaired++;
			}

			maxBuildNumber = Math.max(maxBuildNumber, build.buildNumber);

			const indexed = indexMap.get(buildId);
			if (!indexed) {
				indexData.builds.push(this.buildToSummary(build));
				repaired++;
				console.log(`Added missing build ${buildId} to index for ${projectSlug}`);
			} else if (indexed.status !== build.status || indexed.finishedAt !== build.finishedAt) {
				const idx = indexData.builds.findIndex(b => b.id === buildId);
				if (idx !== -1) {
					indexData.builds[idx] = this.buildToSummary(build);
					repaired++;
					console.log(`Repaired build ${buildId} in ${projectSlug}: ${indexed.status} -> ${build.status}`);
				}
			}
			indexMap.delete(buildId);
		}

		for (const [staleId] of indexMap) {
			const idx = indexData.builds.findIndex(b => b.id === staleId);
			if (idx !== -1) {
				indexData.builds.splice(idx, 1);
				repaired++;
				console.log(`Removed stale index entry ${staleId} from ${projectSlug}`);
			}
		}

		if (maxBuildNumber >= indexData.nextBuildNumber) {
			indexData.nextBuildNumber = maxBuildNumber + 1;
			repaired++;
		}

		if (repaired > 0) {
			await fs.writeFile(buildsPath, JSON.stringify(indexData, null, 2), 'utf-8');
			console.log(`Repaired ${repaired} index entries for ${projectSlug}`);
		}
	}

	private async repairBuildPhases(projectSlug: string, build: Build): Promise<boolean> {
		if (!['success', 'failed', 'cancelled'].includes(build.status)) return false;

		const stalePhases = build.phases.filter(p => p.status === 'running');
		if (stalePhases.length === 0) return false;

		const phaseStatus = build.status === 'success' ? 'success' : 'failed';
		const finishedAt = build.finishedAt ?? new Date().toISOString();

		for (const phase of stalePhases) {
			phase.status = phaseStatus;
			if (!phase.finishedAt) {
				phase.finishedAt = finishedAt;
				if (phase.startedAt) {
					phase.durationMs = new Date(phase.finishedAt).getTime() - new Date(phase.startedAt).getTime();
				}
			}
		}

		await this.buildRepo.update(projectSlug, build.id, { phases: build.phases });
		console.log(`Repaired ${stalePhases.length} stale phase(s) in build ${build.id} (${projectSlug})`);
		return true;
	}

	private async listBuildDirectories(projectSlug: string): Promise<string[]> {
		const dirPath = path.join(this.dataPath, 'builds', projectSlug);
		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true });
			return entries.filter(e => e.isDirectory()).map(e => e.name);
		} catch {
			return [];
		}
	}

	private buildToSummary(build: Build): BuildSummary {
		return {
			id: build.id,
			buildNumber: build.buildNumber,
			status: build.status,
			triggerType: build.triggerType,
			triggeredBy: build.triggeredBy,
			gitCommit: build.gitCommit,
			gitBranch: build.gitBranch,
			config: build.config,
			configurationId: build.configurationId,
			configurationName: build.configurationName,
			cleanBuild: build.cleanBuild,
			startedAt: build.startedAt,
			finishedAt: build.finishedAt,
			durationMs: build.durationMs,
			warningCount: build.warningCount,
			errorCount: build.errorCount,
			testSummary: build.testSummary,
			agentId: build.agentId,
			agentName: build.agentName,
		};
	}

	private updateCounts(state: BuildLiveState, lines: LogLine[]): void {
		for (const line of lines) {
			if (line.level === 'warning') state.warningCount++;
			else if (line.level === 'error') state.errorCount++;
		}
	}

	private emitBuildStatus(buildId: string, status: BuildStatus): void {
		this.io.to(`build:${buildId}`).emit('build:status', { buildId, status });
		this.io.emit('builds:updated');
	}
}

/** Per-build state tracked by the orchestrator while the agent is running it. */
interface BuildLiveState {
	buildId: string;
	projectSlug: string;
	agentId: string;
	agentName: string;
	startedAt: string;
	phases: BuildPhase[];
	warningCount: number;
	errorCount: number;
	pendingPhasePersistence: Promise<void>[];
	repositoryCommits?: RepositoryCommitInfo[];
}
