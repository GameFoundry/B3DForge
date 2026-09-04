import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import type { AgentArch, AgentPlatform } from '@banshee-forge/shared';

export interface AgentConfig {
	orchestratorUrl: string;
	token: string;
	name: string;
	labels: string[];
	/** Target platforms this agent services (ids from `platforms.json`). Defaults to the host OS id. */
	platforms: string[];
	maxParallelBuilds: number;
	platform: AgentPlatform;
	arch: AgentArch;
	hostname: string;
	workspaceRoot: string;
	/** Root holding per-build `results`/`artifacts` directories, keyed by build ID. */
	buildsRoot: string;
	scriptsRoot: string;
	defaultTimeoutMs: number;
}

export interface PartialAgentConfigFile {
	orchestratorUrl?: string;
	token?: string;
	name?: string;
	labels?: string[];
	platforms?: string[];
	maxParallelBuilds?: number;
	workspaceRoot?: string;
	buildsRoot?: string;
	scriptsRoot?: string;
	defaultTimeoutMs?: number;
}

/**
 * Load agent configuration from (in order of precedence): environment variables, the JSON file at
 * `BSF_AGENT_CONFIG` (if set), or `agent.json` in the current working directory if it exists.
 *
 * Required fields are `orchestratorUrl` and `token`. Throws if either is missing. Target
 * platforms come from `BSF_AGENT_PLATFORMS` (comma-separated) and default to the host OS id, so
 * a plain Windows agent services `win32` and a PS5 agent must opt in with `BSF_AGENT_PLATFORMS=ps5`.
 */
export async function loadConfig(): Promise<AgentConfig> {
	const fileConfig = await readConfigFile();

	const orchestratorUrl = (process.env.BSF_ORCHESTRATOR_URL ?? fileConfig.orchestratorUrl ?? '').trim();
	const token = (process.env.BSF_AGENT_TOKEN ?? fileConfig.token ?? '').trim();
	const name = (process.env.BSF_AGENT_NAME ?? fileConfig.name ?? defaultName()).trim();
	const labels = parseLabels(process.env.BSF_AGENT_LABELS) ?? fileConfig.labels ?? [];
	const platforms = parseLabels(process.env.BSF_AGENT_PLATFORMS) ?? fileConfig.platforms ?? [];
	const maxParallelBuilds = Math.max(1, parseInt(
		process.env.BSF_AGENT_MAX_PARALLEL ?? '',
		10,
	) || fileConfig.maxParallelBuilds || 1);

	if (!orchestratorUrl) throw new Error('Missing orchestrator URL (BSF_ORCHESTRATOR_URL)');
	if (!token) throw new Error('Missing agent token (BSF_AGENT_TOKEN)');

	const home = process.env.BANSHEEFORGE_AGENT_HOME ?? path.join(os.homedir(), '.bansheeforge-agent');
	const workspaceRoot = resolveRoot('workspaceRoot',
		process.env.BSF_AGENT_WORKSPACE_ROOT
		|| fileConfig.workspaceRoot
		|| path.join(home, 'workspaces'));
	const scriptsRoot = resolveRoot('scriptsRoot',
		process.env.BSF_AGENT_SCRIPTS_ROOT
		|| fileConfig.scriptsRoot
		|| path.join(home, 'scripts'));
	// Sits alongside the workspaces directory (not inside it) so a workspace wipe can't take the
	// uploaded-but-not-yet-flushed results with it.
	const buildsRoot = resolveRoot('buildsRoot',
		process.env.BSF_AGENT_BUILDS_ROOT
		|| fileConfig.buildsRoot
		|| path.resolve(workspaceRoot, '..', 'builds'));

	const defaultTimeoutMs = parseInt(process.env.BSF_AGENT_TIMEOUT_MS ?? '', 10)
		|| fileConfig.defaultTimeoutMs
		|| 60 * 60 * 1000;

	return {
		orchestratorUrl,
		token,
		name,
		labels,
		platforms: platforms.length ? platforms : [process.platform],
		maxParallelBuilds,
		platform: process.platform as AgentPlatform,
		arch: process.arch as AgentArch,
		hostname: os.hostname(),
		workspaceRoot,
		buildsRoot,
		scriptsRoot,
		defaultTimeoutMs,
	};
}

async function readConfigFile(): Promise<PartialAgentConfigFile> {
	const explicit = process.env.BSF_AGENT_CONFIG;
	const candidates = explicit
		? [explicit]
		: [path.join(process.cwd(), 'agent.json')];

	for (const filePath of candidates) {
		try {
			const text = await fs.readFile(filePath, 'utf-8');
			return JSON.parse(text) as PartialAgentConfigFile;
		} catch (err) {
			if (explicit && (err as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new Error(`Agent config file not found: ${filePath}`);
			}
		}
	}
	return {};
}

/**
 * Validate a configured root directory. These roots are deleted from recursively — workspaces on a
 * clean build, artifacts on a purge — so a blank or relative value would retarget those deletes at
 * the process working directory. Failing at startup makes that misconfiguration loud rather than
 * destructive. Note the `||` chains feeding this: an empty string must fall through to the default,
 * not be accepted as a value.
 */
function resolveRoot(name: string, value: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`Agent ${name} must not be empty`);
	if (!path.isAbsolute(trimmed)) {
		throw new Error(`Agent ${name} must be an absolute path, got '${trimmed}'`);
	}
	return path.normalize(trimmed);
}

function defaultName(): string {
	return `${os.hostname()}-${process.platform}`;
}

function parseLabels(value: string | undefined): string[] | null {
	if (value === undefined) return null;
	return value.split(',').map(s => s.trim()).filter(Boolean);
}
