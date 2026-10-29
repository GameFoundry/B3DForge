import { Router } from 'express';
import { promises as fs } from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
	AggregatedSnapshotResult,
	Build,
	BuildConfiguration,
	BuildStatus,
	BuildSummary,
	ProjectConfig,
	QueueStatus,
	TestFailure,
	TestSuite,
} from '@banshee-forge/shared';
import { DEFAULT_PLATFORM, DEFAULT_SNAPSHOT_CATEGORY, isKnownPlatform, parseLine } from '@banshee-forge/shared';
import { AgentTokensRepository } from '../auth/agent-tokens-repository.js';
import { AuditLog } from '../auth/audit-log.js';
import { BuildRepository } from '../repositories/build-repository.js';
import { BuildGroupRepository } from '../repositories/build-group-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import { TestResultsRepository } from '../repositories/test-results-repository.js';
import { ReferenceRepository } from '../repositories/reference-repository.js';
import { KnownAgentsRepository } from '../repositories/known-agents-repository.js';
import { BuildOrchestrator } from '../services/build-orchestrator.js';
import { BuildTriggerService } from '../services/build-trigger-service.js';
import { ConfigService } from '../services/config-service.js';
import { TestResultsService } from '../services/test-results-service.js';
import { ImageComparisonService } from '../services/image-comparison-service.js';
import { AgentRegistry } from '../services/agent-registry.js';
import { computePlatformAvailability } from '../services/platform-availability.js';
import { resolveConfigurationPlatforms } from '../services/configuration-platforms.js';
import { computeSnapshotDiffPercentage, type SnapshotDiffContext } from '../services/snapshot-diff.js';

export interface McpDependencies {
	configService: ConfigService;
	mcpTokensRepo: AgentTokensRepository;
	projectRepo: ProjectRepository;
	buildRepo: BuildRepository;
	groupRepo: BuildGroupRepository;
	testResultsRepo: TestResultsRepository;
	testResultsService: TestResultsService;
	referenceRepo: ReferenceRepository;
	imageComparison: ImageComparisonService;
	knownAgentsRepo: KnownAgentsRepository;
	agentRegistry: AgentRegistry;
	orchestrator: BuildOrchestrator;
	triggerService: BuildTriggerService;
	auditLog: AuditLog;
}

/** Who is calling, and where the web UI they can link to lives. */
interface McpCaller {
	tokenName: string;
	webBaseUrl: string;
}

const TERMINAL_STATUSES: readonly BuildStatus[] = ['success', 'failed', 'cancelled'];

const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 2000;
/** Longest log line returned; compiler command lines can run to tens of kilobytes. */
const MAX_LOG_LINE_CHARS = 1000;
/** Distinct failures returned per unit test. */
const MAX_FAILURES_PER_TEST = 10;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const WAIT_POLL_INTERVAL_MS = 5000;
const WAIT_PROGRESS_INTERVAL_MS = 30000;

const SERVER_INSTRUCTIONS = `BansheeForge is the CI server for Banshee 3D. Use it to inspect projects, builds, logs and test results, and to start or cancel CI builds.

Never start a build unless the user explicitly asked for one in this conversation: builds occupy shared agents and devkits for a long time, and a build only sees commits that are reachable from the project's git URL (pushed, or committed when the project builds from a local path).

Investigating a build: get_build first (status, failed phase, commits of the main repository and every submodule, test summary), then get_build_log with level="error" or grep, get_unit_test_results and get_snapshot_results, and get_snapshot_image to look at a failing screenshot next to its reference.`;

/** MCP endpoint (Streamable HTTP, stateless) served by the main server at `/mcp`. */
export function createMcpRoutes(deps: McpDependencies): Router {
	const router = Router();

	router.use(async (req, res, next) => {
		try {
			if (!deps.configService.getConfig().mcp.enabled) {
				res.status(404).json({ error: 'Not found', message: 'The MCP endpoint is disabled in the server settings' });
				return;
			}

			const header = req.headers.authorization;
			const plaintext = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
			const token = plaintext ? await deps.mcpTokensRepo.findByPlaintext(plaintext) : null;
			if (!token) {
				res.status(401).json({ error: 'Unauthorized', message: 'An MCP token (Settings → MCP) is required as a Bearer token' });
				return;
			}
			await deps.mcpTokensRepo.updateLastUsed(token.id);
			res.locals.mcpCaller = { tokenName: token.name, webBaseUrl: `${req.protocol}://${req.get('host')}` } satisfies McpCaller;
			next();
		} catch (err) {
			next(err);
		}
	});

	// Stateless: every request gets its own server and transport, so nothing is kept between calls.
	router.post('/', async (req, res, next) => {
		try {
			const server = createMcpServer(deps, res.locals.mcpCaller as McpCaller);
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			res.on('close', () => {
				void transport.close();
				void server.close();
			});
			await server.connect(transport);
			await transport.handleRequest(req, res, req.body);
		} catch (err) {
			next(err);
		}
	});

	// A stateless server has no server-initiated stream and no session to delete.
	router.all('/', (_req, res) => {
		res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
	});

	return router;
}

function textResult(value: unknown): CallToolResult {
	return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}… [${text.length - maxChars} more chars]` : text;
}

function createMcpServer(deps: McpDependencies, caller: McpCaller): McpServer {
	const server = new McpServer(
		{ name: 'banshee-forge', version: '0.1.0' },
		{ instructions: SERVER_INSTRUCTIONS },
	);

	const buildUrl = (buildId: string) => `${caller.webBaseUrl}/builds/${buildId}`;

	async function findBuild(buildId: string): Promise<Build | null> {
		for (const project of await deps.projectRepo.findAll()) {
			const build = await deps.buildRepo.findById(project.slug, buildId);
			if (build) return build;
		}
		return null;
	}

	/** Build ids named directly or through their group, or an error message. */
	async function resolveBuildIds(buildIds: string[] | undefined, groupId: string | undefined): Promise<string[] | string> {
		const ids = [...(buildIds ?? [])];
		if (groupId) {
			let found = false;
			for (const project of await deps.projectRepo.findAll()) {
				const group = await deps.groupRepo.findById(project.slug, groupId);
				if (!group) continue;
				ids.push(...group.buildIds);
				found = true;
				break;
			}
			if (!found) return `Build group ${groupId} not found`;
		}
		if (ids.length === 0) return 'Pass build_ids or group_id';
		return [...new Set(ids)];
	}

	function queueInfo(queue: QueueStatus, buildId: string): { queuePosition?: number; pendingReason?: string } {
		const index = queue.queue.findIndex(entry => entry.buildId === buildId);
		if (index === -1) return {};
		return { queuePosition: index + 1, pendingReason: queue.queue[index].pendingReason };
	}

	function summarize(build: BuildSummary, queue: QueueStatus) {
		return {
			id: build.id,
			buildNumber: build.buildNumber,
			status: build.status,
			platform: build.platform,
			configurationId: build.configurationId,
			configurationName: build.configurationName,
			settings: build.config,
			gitBranch: build.gitBranch,
			gitCommit: build.gitCommit,
			triggerType: build.triggerType,
			triggeredBy: build.triggeredBy,
			agentName: build.agentName,
			groupId: build.groupId,
			startedAt: build.startedAt,
			finishedAt: build.finishedAt,
			durationMs: build.durationMs,
			warningCount: build.warningCount,
			errorCount: build.errorCount,
			testSummary: build.testSummary,
			...(build.status === 'pending' ? queueInfo(queue, build.id) : {}),
		};
	}

	server.registerTool('list_projects', {
		title: 'List projects',
		description: 'List every CI project with its build configurations: supported platforms, the build settings each configuration accepts (configSchema) and their defaults, and the repository scripts it runs.',
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, async () => {
		const projects = await deps.projectRepo.findAll();
		return textResult(projects.map(project => ({
			slug: project.slug,
			name: project.name,
			description: project.description,
			gitUrl: project.gitUrl,
			gitBranch: project.gitBranch,
			defaultConfigurationId: project.defaultConfigurationId,
			autoBuild: project.autoBuild,
			configurations: project.configurations.map(configuration => ({
				id: configuration.id,
				name: configuration.name,
				description: configuration.description,
				gitBranch: configuration.gitBranch,
				platforms: resolveConfigurationPlatforms(configuration),
				settingsSchema: configuration.configSchema ?? {},
				defaultSettings: configuration.defaultConfig ?? {},
				buildScript: configuration.buildScript,
				testScript: configuration.testScript,
			})),
		})));
	});

	server.registerTool('list_platforms', {
		title: 'List platforms',
		description: 'List target platforms and the agents that build them. "connected" platforms start builds right away; builds for "offline" platforms wait in the queue until an agent connects; "never-seen" platforms have no agent at all.',
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, async () => {
		const known = await deps.knownAgentsRepo.list();
		return textResult(computePlatformAvailability(deps.agentRegistry, known));
	});

	server.registerTool('list_builds', {
		title: 'List builds',
		description: 'List builds of a project, newest first, including pending (queued, with the reason they wait), running and finished ones.',
		inputSchema: {
			project: z.string().describe('Project slug (see list_projects)'),
			status: z.array(z.enum(['pending', 'running', 'success', 'failed', 'cancelled'])).optional().describe('Only builds in these states'),
			platform: z.string().optional().describe('Only builds for this platform'),
			configuration_id: z.string().optional().describe('Only builds of this configuration'),
			limit: z.number().int().min(1).max(200).default(20),
			offset: z.number().int().min(0).default(0).describe('Number of matching builds to skip'),
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, async ({ project: slug, status, platform, configuration_id, limit, offset }) => {
		const project = await deps.projectRepo.findBySlug(slug);
		if (!project) return errorResult(`Project ${slug} not found`);

		const { builds } = await deps.buildRepo.findAllForProject(slug, 1, Number.MAX_SAFE_INTEGER);
		const matching = builds.filter(build =>
			(!status || status.includes(build.status))
			&& (!platform || build.platform === platform)
			&& (!configuration_id || build.configurationId === configuration_id));
		const queue = deps.orchestrator.getQueueStatus();
		return textResult({
			total: matching.length,
			offset,
			builds: matching.slice(offset, offset + limit).map(build => summarize(build, queue)),
		});
	});

	server.registerTool('get_build', {
		title: 'Get build details',
		description: 'Details of one build: status, phases (with the failed one), the commit of the main repository and of every submodule, build settings, the other builds of its group, test summaries per kind and a link to the web UI.',
		inputSchema: { build_id: z.string() },
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, async ({ build_id }) => {
		const build = await findBuild(build_id);
		if (!build) return errorResult(`Build ${build_id} not found`);

		const queue = deps.orchestrator.getQueueStatus();
		const group = build.groupId ? await deps.groupRepo.findById(build.projectSlug, build.groupId) : null;
		const groupBuilds = [];
		for (const id of group?.buildIds ?? []) {
			const member = await deps.buildRepo.findById(build.projectSlug, id);
			if (member) groupBuilds.push({ id: member.id, buildNumber: member.buildNumber, platform: member.platform, status: member.status });
		}

		const results = await deps.testResultsService.getResults(build.projectSlug, build.id);
		const snapshotCategories: Record<string, { total: number; passed: number; notPassed: number }> = {};
		for (const snapshot of results?.snapshotTests?.results ?? []) {
			const category = snapshot.category ?? DEFAULT_SNAPSHOT_CATEGORY;
			const entry = snapshotCategories[category] ??= { total: 0, passed: 0, notPassed: 0 };
			entry.total++;
			if (snapshot.statusText === 'passed') entry.passed++;
			else entry.notPassed++;
		}

		return textResult({
			...summarize(build, queue),
			projectSlug: build.projectSlug,
			url: buildUrl(build.id),
			cleanBuild: build.cleanBuild,
			failedPhase: build.phases.find(phase => phase.status === 'failed')?.name,
			phases: build.phases.map(phase => ({
				name: phase.name,
				status: phase.status,
				durationMs: phase.durationMs,
				exitCode: phase.exitCode,
				warningCount: phase.warningCount,
				errorCount: phase.errorCount,
			})),
			repositories: build.repositoryCommits
				?? (build.status === 'pending' || build.status === 'running'
					? `Not recorded yet; the root commit is ${build.gitCommit} and submodule commits are recorded once the fetch phase finishes.`
					: build.submoduleCommits ?? null),
			group: group ? { id: group.id, rootCommit: group.rootCommit, autoDeploy: group.autoDeploy, builds: groupBuilds } : undefined,
			tests: {
				resultsComplete: build.testResultsComplete ?? false,
				resultsUploadComplete: build.resultsUploadComplete,
				unit: results?.unitTests?.summary ?? null,
				snapshots: results?.snapshotTests ? { ...results.snapshotTests.summary, categories: snapshotCategories } : null,
			},
		});
	});

	server.registerTool('get_build_log', {
		title: 'Get build log',
		description: 'Read a build log: the full build log (source "build"), the unit test console output ("unit_tests") or the engine log of one snapshot test ("snapshot", with category and test). Filter by phase, level and/or a regular expression; without offset the last `limit` matching lines are returned. Every line is prefixed with its line number, so a later call can page with offset.',
		inputSchema: {
			build_id: z.string(),
			source: z.enum(['build', 'unit_tests', 'snapshot']).default('build'),
			category: z.string().optional().describe('Snapshot category (e.g. Vulkan, D3D12, Editor) when source is "snapshot"'),
			test: z.string().optional().describe('Snapshot test name when source is "snapshot"'),
			phase: z.string().optional().describe('Only lines of this phase (build log phases: fetch, configure, compile, setup, unit-tests, ...; see get_build)'),
			level: z.enum(['error', 'warning', 'error_or_warning']).optional().describe('Only lines classified as errors and/or warnings'),
			grep: z.string().optional().describe('Only lines matching this regular expression (case-insensitive)'),
			context: z.number().int().min(0).max(50).default(0).describe('Lines of context around each line matched by level/grep'),
			offset: z.number().int().min(1).optional().describe('Return matching lines starting at this line number instead of the tail'),
			limit: z.number().int().min(1).max(MAX_LOG_LIMIT).default(DEFAULT_LOG_LIMIT),
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, async ({ build_id, source, category, test, phase, level, grep, context, offset, limit }) => {
		const build = await findBuild(build_id);
		if (!build) return errorResult(`Build ${build_id} not found`);

		let log: string | null;
		if (source === 'build') {
			log = await deps.buildRepo.getLog(build.projectSlug, build.id);
		} else if (source === 'unit_tests') {
			log = await deps.testResultsRepo.getUnitTestLog(build.projectSlug, build.id);
		} else {
			if (!category || !test) return errorResult('source "snapshot" needs category and test (see get_snapshot_results)');
			log = await deps.testResultsService.getSnapshotLog(build.projectSlug, build.id, category, test);
		}
		if (log === null) return errorResult(`No ${source} log stored for build ${build_id}`);

		let matcher: RegExp | null = null;
		if (grep) {
			try {
				matcher = new RegExp(grep, 'i');
			} catch (err) {
				return errorResult(`Invalid grep expression: ${(err as Error).message}`);
			}
		}

		const lines = log.split(/\r?\n/);
		if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

		// Phase markers switch the current phase; level comes from the same classifier the web UI uses.
		const phaseStarts: { name: string; line: number }[] = [];
		let currentPhase = 'init';
		const inPhase: boolean[] = [];
		const matched: boolean[] = [];
		for (let i = 0; i < lines.length; i++) {
			const parsed = parseLine(lines[i]);
			if (parsed.phase) {
				currentPhase = parsed.phase;
				phaseStarts.push({ name: parsed.phase, line: i + 1 });
			}
			inPhase[i] = !phase || currentPhase === phase;
			const levelMatch = !level
				|| (level === 'error' && parsed.level === 'error')
				|| (level === 'warning' && parsed.level === 'warning')
				|| (level === 'error_or_warning' && (parsed.level === 'error' || parsed.level === 'warning'));
			matched[i] = inPhase[i] && levelMatch && (!matcher || matcher.test(lines[i]));
		}

		const selected: number[] = [];
		const filtered = !!level || !!matcher;
		if (filtered && context > 0) {
			const include = new Array<boolean>(lines.length).fill(false);
			for (let i = 0; i < lines.length; i++) {
				if (!matched[i]) continue;
				for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++)
					include[j] = inPhase[j];
			}
			for (let i = 0; i < lines.length; i++) if (include[i]) selected.push(i);
		} else {
			for (let i = 0; i < lines.length; i++) if (matched[i]) selected.push(i);
		}

		const startIndex = offset !== undefined ? selected.findIndex(i => i + 1 >= offset) : Math.max(0, selected.length - limit);
		const page = startIndex === -1 ? [] : selected.slice(startIndex, startIndex + limit);
		const header = [
			`${source} log of build #${build.buildNumber} (${build.platform}, ${build.status}): ${lines.length} lines, ${selected.length} selected, returning ${page.length}`
				+ (page.length > 0 ? ` (lines ${page[0] + 1}-${page[page.length - 1] + 1})` : ''),
		];
		if (source === 'build' && phaseStarts.length > 0)
			header.push(`Phases start at: ${phaseStarts.map(p => `${p.name}@${p.line}`).join(', ')}`);
		const lastIndex = startIndex === -1 ? -1 : startIndex + page.length;
		if (lastIndex !== -1 && lastIndex < selected.length)
			header.push(`More lines follow; continue with offset=${selected[lastIndex] + 1}`);
		if (offset === undefined && startIndex > 0)
			header.push(`Earlier lines exist; page backwards with a smaller offset`);

		let previous = -2;
		const body: string[] = [];
		for (const index of page) {
			if (previous >= 0 && index !== previous + 1) body.push('--');
			body.push(`${index + 1}: ${truncate(lines[index], MAX_LOG_LINE_CHARS)}`);
			previous = index;
		}
		return textResult(`${header.join('\n')}\n\n${body.join('\n')}`);
	});

	server.registerTool('get_unit_test_results', {
		title: 'Get unit test results',
		description: 'Unit test results of a build: totals, and per suite the failing tests with their failure messages and source locations. When results are missing or contradict the build status (the runner can crash before writing its JSON), read the console output with get_build_log source="unit_tests".',
		inputSchema: {
			build_id: z.string(),
			failed_only: z.boolean().default(true).describe('Only suites and tests that failed'),
			suite: z.string().optional().describe('Only suites whose name contains this text'),
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, async ({ build_id, failed_only, suite }) => {
		const build = await findBuild(build_id);
		if (!build) return errorResult(`Build ${build_id} not found`);

		const raw = await deps.testResultsService.getUnitTests(build.projectSlug, build.id);
		const stored = raw ? null : (await deps.testResultsService.getResults(build.projectSlug, build.id))?.unitTests;
		const suites: TestSuite[] = raw?.suites ?? stored?.suites ?? [];
		if (!raw && !stored) {
			return textResult({
				build: { id: build.id, status: build.status, settings: build.config, testResultsComplete: build.testResultsComplete ?? false },
				message: 'No unit test results were stored for this build. It may still be running, have failed before the tests ran, have been run without tests, or the runner crashed before writing its JSON; check get_build_log source="unit_tests" and the build log.',
			});
		}

		const filter = suite?.toLowerCase();
		const shown = suites
			.filter(s => !filter || s.name.toLowerCase().includes(filter))
			.filter(s => !failed_only || s.failedTests > 0 || s.tests.some(t => !t.passed))
			.map(s => ({
				name: s.name,
				total: s.totalTests,
				passed: s.passedTests,
				failed: s.failedTests,
				durationMs: Math.round(s.durationUs / 1000),
				tests: s.tests
					.filter(t => !failed_only || !t.passed)
					.map(t => ({
						name: t.name,
						passed: t.passed,
						durationMs: Math.round(t.durationUs / 1000),
						...(t.failures?.length ? { failures: summarizeFailures(t.failures) } : {}),
					})),
			}));

		return textResult({
			build: { id: build.id, buildNumber: build.buildNumber, platform: build.platform, status: build.status },
			summary: raw
				? { suites: raw.summary.totalSuites, total: raw.summary.totalTests, passed: raw.summary.passedTests, failed: raw.summary.failedTests }
				: stored!.summary,
			suites: shown,
		});
	});

	server.registerTool('get_snapshot_results', {
		title: 'Get snapshot test results',
		description: 'Snapshot (screenshot) test results of a build per category (GPU backend / editor): verdict, logged errors and warnings, and how much the screenshot differs from the reference image (diffPercentage). Use get_snapshot_image to look at a screenshot, its reference and the diff, and get_build_log source="snapshot" for the full engine log.',
		inputSchema: {
			build_id: z.string(),
			filter: z.enum(['failed', 'not_passed', 'all']).default('not_passed')
				.describe('"failed": failed and crashed; "not_passed": also passed_with_warnings; "all": every test'),
			category: z.string().optional(),
			compare: z.boolean().default(true).describe('Compute diffPercentage against the reference image for the returned tests'),
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, async ({ build_id, filter, category, compare }) => {
		const build = await findBuild(build_id);
		if (!build) return errorResult(`Build ${build_id} not found`);

		const snapshotTests = (await deps.testResultsService.getResults(build.projectSlug, build.id))?.snapshotTests;
		if (!snapshotTests) {
			return textResult({
				build: { id: build.id, status: build.status, settings: build.config, testResultsComplete: build.testResultsComplete ?? false },
				message: 'No snapshot results were stored for this build (still running, failed before the tests ran, or run without tests).',
			});
		}

		const all = snapshotTests.results.map(s => ({ ...s, category: s.category ?? DEFAULT_SNAPSHOT_CATEGORY }));
		const shown = all.filter(s =>
			(!category || s.category === category)
			&& (filter === 'all'
				|| (filter === 'failed' && (s.statusText === 'failed' || s.statusText === 'crashed'))
				|| (filter === 'not_passed' && s.statusText !== 'passed')));

		const configurationId = build.configurationId || 'default';
		const platform = build.platform ?? DEFAULT_PLATFORM;
		const manifest = await deps.referenceRepo.getManifest(build.projectSlug, configurationId, platform);
		const diffContext: SnapshotDiffContext = {
			testResultsRepo: deps.testResultsRepo,
			referenceRepo: deps.referenceRepo,
			imageComparison: deps.imageComparison,
			projectSlug: build.projectSlug,
			buildId: build.id,
			configurationId,
			platform,
		};

		const results = await Promise.all(shown.map(async (snapshot: AggregatedSnapshotResult) => {
			const hasReference = !!manifest.references[`${snapshot.category}/${snapshot.testName}`];
			return {
				category: snapshot.category,
				test: snapshot.testName,
				status: snapshot.statusText,
				totalFrames: snapshot.totalFrames,
				executionTimeSeconds: snapshot.executionTimeSeconds,
				errors: snapshot.errors.slice(0, 20).map(e => truncate(e, 500)),
				...(snapshot.errors.length > 20 ? { moreErrors: snapshot.errors.length - 20 } : {}),
				warnings: snapshot.warnings.slice(0, 10).map(w => truncate(w, 500)),
				...(snapshot.warnings.length > 10 ? { moreWarnings: snapshot.warnings.length - 10 } : {}),
				hasReference,
				...(compare && hasReference ? { diffPercentage: await computeSnapshotDiffPercentage(diffContext, snapshot) } : {}),
			};
		}));

		const categories: Record<string, Record<string, number>> = {};
		for (const snapshot of all) {
			const counts = categories[snapshot.category] ??= {};
			counts[snapshot.statusText] = (counts[snapshot.statusText] ?? 0) + 1;
		}

		return textResult({
			build: { id: build.id, buildNumber: build.buildNumber, platform: build.platform, status: build.status },
			summary: snapshotTests.summary,
			categories,
			results,
		});
	});

	server.registerTool('get_snapshot_image', {
		title: 'Get snapshot image',
		description: 'A PNG of a snapshot test: the screenshot the build captured, the reference image it is compared against, or the diff between them (differing pixels highlighted).',
		inputSchema: {
			build_id: z.string(),
			category: z.string(),
			test: z.string(),
			kind: z.enum(['screenshot', 'reference', 'diff']).default('screenshot'),
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, async ({ build_id, category, test, kind }) => {
		const build = await findBuild(build_id);
		if (!build) return errorResult(`Build ${build_id} not found`);

		const configurationId = build.configurationId || 'default';
		const platform = build.platform ?? DEFAULT_PLATFORM;
		const screenshotPath = await deps.testResultsRepo.resolveSnapshotFilePath(build.projectSlug, build.id, category, test, 'screenshot.png');
		const referencePath = deps.referenceRepo.getReferenceImagePath(build.projectSlug, configurationId, platform, category, test);
		if (kind !== 'reference' && !screenshotPath) return errorResult(`Snapshot test ${category}/${test} not found in build ${build_id}`);

		let imagePath: string;
		let note = '';
		if (kind === 'screenshot') {
			imagePath = screenshotPath!;
		} else if (kind === 'reference') {
			if (!await deps.referenceRepo.hasReference(build.projectSlug, configurationId, platform, category, test))
				return errorResult(`No reference image is set for ${category}/${test} on ${platform}`);
			imagePath = referencePath;
		} else {
			if (!await deps.referenceRepo.hasReference(build.projectSlug, configurationId, platform, category, test))
				return errorResult(`No reference image is set for ${category}/${test} on ${platform}, so there is no diff`);
			imagePath = (await deps.testResultsRepo.resolveSnapshotFilePath(build.projectSlug, build.id, category, test, 'diff.png'))!;
			const comparison = await deps.imageComparison.compareImages(screenshotPath!, referencePath, imagePath);
			if (comparison.error) return errorResult(`Comparison failed: ${comparison.error}`);
			note = `${comparison.diffPixels} of ${comparison.totalPixels} pixels differ (${comparison.diffPercentage.toFixed(3)}%)`;
		}

		let data: Buffer;
		try {
			data = await fs.readFile(imagePath);
		} catch {
			return errorResult(`The ${kind} image of ${category}/${test} is missing`);
		}
		if (data.length === 0) return errorResult(`The ${kind} image of ${category}/${test} is empty`);
		if (data.length > MAX_IMAGE_BYTES) return errorResult(`The ${kind} image is ${data.length} bytes, too large to return`);

		return {
			content: [
				{ type: 'text', text: `${kind} of ${category}/${test}, build #${build.buildNumber} (${platform})${note ? `: ${note}` : ''}` },
				{ type: 'image', data: data.toString('base64'), mimeType: 'image/png' },
			],
		};
	});

	server.registerTool('trigger_builds', {
		title: 'Start CI builds',
		description: 'Start CI builds of one configuration, one build per platform, all building the same root commit as one build group. ONLY call this when the user explicitly asked for a CI build in this conversation; never on your own initiative. Builds check out the branch head (or git_commit) from the project\'s git URL: commits that are not pushed there are not built (unless the project builds from a local path). Use wait_for_builds to wait for the result.',
		inputSchema: {
			project: z.string().describe('Project slug (see list_projects)'),
			platforms: z.array(z.string()).min(1).describe('Target platforms, e.g. ["win32", "darwin", "ps5"]; must be supported by the configuration'),
			configuration_id: z.string().optional().describe("Defaults to the project's default configuration"),
			git_branch: z.string().optional().describe('Defaults to the configuration or project branch'),
			git_commit: z.string().optional().describe('Root commit to build; defaults to the branch head'),
			settings: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
				.describe('Build settings per the configuration settingsSchema (e.g. {"buildType": "Debug", "runTests": true}); unspecified ones keep their defaults'),
			clean_build: z.boolean().default(false).describe('Wipe the agent workspace before building (much slower)'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	}, async ({ project: slug, platforms, configuration_id, git_branch, git_commit, settings, clean_build }) => {
		const project = await deps.projectRepo.findBySlug(slug);
		if (!project) return errorResult(`Project ${slug} not found`);

		const configurationId = configuration_id ?? project.defaultConfigurationId;
		const configuration = project.configurations.find(c => c.id === configurationId);
		if (!configuration) return errorResult(`Configuration ${configurationId ?? '(none)'} not found in ${slug}`);

		const uniquePlatforms = [...new Set(platforms)];
		const unknown = uniquePlatforms.filter(p => !isKnownPlatform(p));
		if (unknown.length > 0) return errorResult(`Unknown platform(s): ${unknown.join(', ')}`);
		const supported = resolveConfigurationPlatforms(configuration);
		const unsupported = uniquePlatforms.filter(p => !supported.includes(p));
		if (unsupported.length > 0)
			return errorResult(`Configuration ${configuration.name} does not support ${unsupported.join(', ')}; it supports ${supported.join(', ')}`);

		const config = resolveBuildSettings(configuration, settings ?? {});
		if (typeof config === 'string') return errorResult(config);

		let triggered;
		try {
			triggered = await deps.triggerService.triggerGroup({
				project,
				configuration,
				platforms: uniquePlatforms,
				triggerType: 'manual',
				triggeredBy: `mcp:${caller.tokenName}`,
				gitBranch: git_branch,
				gitCommit: git_commit,
				config,
				cleanBuild: clean_build,
			});
		} catch (err) {
			return errorResult(`Could not resolve sources: ${(err as Error).message}`);
		}

		for (const build of triggered.builds) {
			deps.auditLog.append({
				actor: `mcp:${caller.tokenName}`,
				action: 'build.trigger',
				target: `${slug}/${build.id}`,
				details: { configurationId: configuration.id, configurationName: configuration.name, platform: build.platform, groupId: triggered.group.id },
			});
		}

		const availability = computePlatformAvailability(deps.agentRegistry, await deps.knownAgentsRepo.list());
		const waiting = uniquePlatforms.filter(p => availability.find(a => a.id === p)?.status !== 'connected');

		return textResult({
			groupId: triggered.group.id,
			gitBranch: triggered.group.gitBranch,
			rootCommit: triggered.group.rootCommit,
			settings: config,
			builds: triggered.builds.map(build => ({ id: build.id, buildNumber: build.buildNumber, platform: build.platform, url: buildUrl(build.id) })),
			...(waiting.length > 0 ? { note: `No connected agent builds ${waiting.join(', ')}; those builds wait in the queue until one connects.` } : {}),
		});
	});

	server.registerTool('cancel_builds', {
		title: 'Cancel CI builds',
		description: 'Cancel pending or running builds, named directly or by their build group. Only cancel builds the user asked you to cancel or that you started yourself.',
		inputSchema: {
			build_ids: z.array(z.string()).optional(),
			group_id: z.string().optional().describe('Cancel every unfinished build of this group'),
		},
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	}, async ({ build_ids, group_id }) => {
		const ids = await resolveBuildIds(build_ids, group_id);
		if (typeof ids === 'string') return errorResult(ids);

		const outcomes = [];
		for (const id of ids) {
			const build = await findBuild(id);
			if (!build) {
				outcomes.push({ id, result: 'not found' });
				continue;
			}
			if (build.status !== 'pending' && build.status !== 'running') {
				outcomes.push({ id, platform: build.platform, result: `already ${build.status}` });
				continue;
			}
			if (!deps.orchestrator.cancelBuild(id)) {
				outcomes.push({ id, platform: build.platform, result: 'could not be cancelled' });
				continue;
			}
			await deps.buildRepo.updateStatus(build.projectSlug, id, 'cancelled');
			deps.auditLog.append({ actor: `mcp:${caller.tokenName}`, action: 'build.cancel', target: `${build.projectSlug}/${id}` });
			outcomes.push({ id, platform: build.platform, result: 'cancelled' });
		}
		return textResult(outcomes);
	});

	server.registerTool('wait_for_builds', {
		title: 'Wait for builds',
		description: 'Wait until the given builds (or every build of a group) have finished, or until the timeout passes, then return their states. A full build with tests takes tens of minutes; call again while some are still pending or running.',
		inputSchema: {
			build_ids: z.array(z.string()).optional(),
			group_id: z.string().optional(),
			timeout_seconds: z.number().int().min(0).max(3600).default(600),
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, async ({ build_ids, group_id, timeout_seconds }, extra) => {
		const ids = await resolveBuildIds(build_ids, group_id);
		if (typeof ids === 'string') return errorResult(ids);

		const deadline = Date.now() + timeout_seconds * 1000;
		const progressToken = extra._meta?.progressToken;
		let nextProgressAt = Date.now() + WAIT_PROGRESS_INTERVAL_MS;
		for (;;) {
			const builds = await Promise.all(ids.map(findBuild));
			const missing = ids.filter((_, i) => !builds[i]);
			if (missing.length > 0) return errorResult(`Build(s) not found: ${missing.join(', ')}`);

			const finished = builds.filter(b => TERMINAL_STATUSES.includes(b!.status)).length;
			if (finished === ids.length || Date.now() >= deadline || extra.signal.aborted) {
				const queue = deps.orchestrator.getQueueStatus();
				return textResult({
					allFinished: finished === ids.length,
					finished,
					total: ids.length,
					builds: builds.map(b => ({ ...summarize(b!, queue), url: buildUrl(b!.id) })),
				});
			}

			if (progressToken !== undefined && Date.now() >= nextProgressAt) {
				nextProgressAt = Date.now() + WAIT_PROGRESS_INTERVAL_MS;
				await extra.sendNotification({
					method: 'notifications/progress',
					params: { progressToken, progress: finished, total: ids.length, message: `${finished}/${ids.length} builds finished` },
				}).catch(() => undefined);
			}

			await new Promise(resolve => setTimeout(resolve, Math.min(WAIT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))));
		}
	});

	return server;
}

/**
 * Failures of one test with identical repeats folded into a count; a test that fails inside a loop
 * can report the same failure hundreds of times.
 */
function summarizeFailures(failures: TestFailure[]): (TestFailure & { count?: number })[] {
	const unique = new Map<string, TestFailure & { count?: number }>();
	for (const failure of failures) {
		const key = `${failure.file}:${failure.line}:${failure.description}`;
		const entry = unique.get(key);
		if (entry) entry.count = (entry.count ?? 1) + 1;
		else unique.set(key, { ...failure, description: truncate(failure.description, 2000) });
	}
	return [...unique.values()].slice(0, MAX_FAILURES_PER_TEST);
}

/**
 * Build settings for a trigger: the configuration's defaults (falling back to schema defaults)
 * overridden by `requested`, validated against the configuration's schema. Returns an error
 * message on a bad key or value.
 */
function resolveBuildSettings(configuration: BuildConfiguration, requested: ProjectConfig): ProjectConfig | string {
	const schema = configuration.configSchema ?? {};
	const config: ProjectConfig = {};
	for (const [key, field] of Object.entries(schema))
		if (field.default !== undefined) config[key] = field.default;
	Object.assign(config, configuration.defaultConfig ?? {});

	for (const [key, value] of Object.entries(requested)) {
		const field = schema[key];
		if (!field) {
			const valid = Object.keys(schema);
			return `Unknown setting "${key}"; ${configuration.name} accepts ${valid.length > 0 ? valid.join(', ') : 'no settings'}`;
		}
		const valid = field.type === 'select'
			? (field.options ?? []).includes(String(value))
			: field.type === 'boolean' ? typeof value === 'boolean'
			: field.type === 'number' ? typeof value === 'number'
			: typeof value === 'string';
		if (!valid) {
			return field.type === 'select'
				? `Setting "${key}" must be one of ${(field.options ?? []).join(', ')}`
				: `Setting "${key}" must be a ${field.type}`;
		}
		config[key] = field.type === 'select' ? String(value) : value;
	}
	return config;
}
