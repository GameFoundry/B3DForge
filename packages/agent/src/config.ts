import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import type { AgentArch, AgentPlatform } from '@banshee-forge/shared';

export interface AgentConfig {
	orchestratorUrl: string;
	token: string;
	name: string;
	labels: string[];
	maxParallelBuilds: number;
	platform: AgentPlatform;
	arch: AgentArch;
	hostname: string;
	workspaceRoot: string;
	scriptsRoot: string;
	defaultTimeoutMs: number;
}

export interface PartialAgentConfigFile {
	orchestratorUrl?: string;
	token?: string;
	name?: string;
	labels?: string[];
	maxParallelBuilds?: number;
	workspaceRoot?: string;
	scriptsRoot?: string;
	defaultTimeoutMs?: number;
}

/**
 * Load agent configuration from (in order of precedence): environment variables, the JSON file at
 * `BSF_AGENT_CONFIG` (if set), or `agent.json` in the current working directory if it exists.
 *
 * Required fields are `orchestratorUrl` and `token`. Throws if either is missing.
 */
export async function loadConfig(): Promise<AgentConfig> {
	const fileConfig = await readConfigFile();

	const orchestratorUrl = (process.env.BSF_ORCHESTRATOR_URL ?? fileConfig.orchestratorUrl ?? '').trim();
	const token = (process.env.BSF_AGENT_TOKEN ?? fileConfig.token ?? '').trim();
	const name = (process.env.BSF_AGENT_NAME ?? fileConfig.name ?? defaultName()).trim();
	const labels = parseLabels(process.env.BSF_AGENT_LABELS) ?? fileConfig.labels ?? [];
	const maxParallelBuilds = Math.max(1, parseInt(
		process.env.BSF_AGENT_MAX_PARALLEL ?? '',
		10,
	) || fileConfig.maxParallelBuilds || 1);

	if (!orchestratorUrl) throw new Error('Missing orchestrator URL (BSF_ORCHESTRATOR_URL)');
	if (!token) throw new Error('Missing agent token (BSF_AGENT_TOKEN)');

	const home = process.env.BANSHEEFORGE_AGENT_HOME ?? path.join(os.homedir(), '.bansheeforge-agent');
	const workspaceRoot = process.env.BSF_AGENT_WORKSPACE_ROOT
		?? fileConfig.workspaceRoot
		?? path.join(home, 'workspaces');
	const scriptsRoot = process.env.BSF_AGENT_SCRIPTS_ROOT
		?? fileConfig.scriptsRoot
		?? path.join(home, 'scripts');

	const defaultTimeoutMs = parseInt(process.env.BSF_AGENT_TIMEOUT_MS ?? '', 10)
		|| fileConfig.defaultTimeoutMs
		|| 60 * 60 * 1000;

	return {
		orchestratorUrl,
		token,
		name,
		labels,
		maxParallelBuilds,
		platform: process.platform as AgentPlatform,
		arch: process.arch as AgentArch,
		hostname: os.hostname(),
		workspaceRoot,
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

function defaultName(): string {
	return `${os.hostname()}-${process.platform}`;
}

function parseLabels(value: string | undefined): string[] | null {
	if (value === undefined) return null;
	return value.split(',').map(s => s.trim()).filter(Boolean);
}
