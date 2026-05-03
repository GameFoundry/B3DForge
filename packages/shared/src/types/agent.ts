import type { Build, BuildPhase, RepositoryCommitInfo } from './build.js';
import type { BuildConfiguration, Project } from './project.js';
import type { LogLine, BuildErrorCode } from './execution.js';

/** Operating system platforms supported by build agents. */
export type AgentPlatform = 'win32' | 'linux' | 'darwin';

/** CPU architectures supported by build agents. */
export type AgentArch = 'x64' | 'arm64';

/**
 * Static information about a build agent that doesn't change for the lifetime of a connection.
 * Sent by the agent in `agent:register` immediately after the Socket.IO handshake.
 */
export interface AgentRegistration {
	/** Human-readable name. Convention: matches the agent token name. */
	name: string;
	platform: AgentPlatform;
	arch: AgentArch;
	hostname: string;
	/** Free-form labels used for build-to-agent matching (e.g. ["gpu-nvidia", "high-mem"]). */
	labels: string[];
	/** Maximum number of builds this agent will run concurrently. */
	maxParallelBuilds: number;
	/** Agent package version, e.g. "0.1.0". */
	version: string;
}

/**
 * Periodic heartbeat / status report sent by the agent.
 */
export interface AgentStatus {
	activeBuildIds: string[];
	/** Optional CPU load average (0..1). May be omitted if the agent doesn't track it. */
	cpuLoad?: number;
}

/**
 * Public view of an agent currently connected to the orchestrator. Returned by the agents API
 * and broadcast over the web Socket.IO namespace when agents connect/disconnect.
 */
export interface AgentInfo extends AgentRegistration {
	/** Server-assigned ID, unique per connection. */
	id: string;
	connectedAt: string;
	lastSeenAt: string;
	activeBuildIds: string[];
}

/**
 * Build dispatch payload sent from orchestrator to agent over `build:assign`.
 *
 * Scripts are inlined (small text bodies) so the agent doesn't need filesystem access to the
 * orchestrator. For `ScriptConfig.source === 'repo'`, the script body is `null` and the agent
 * resolves it from the workspace after the fetch phase.
 */
export interface BuildAssignment {
	build: Build;
	project: Project;
	configuration?: BuildConfiguration;
	scripts: {
		fetch: ScriptPayload;
		build: ScriptPayload;
		test?: ScriptPayload;
	};
}

/**
 * Script delivery method. Either an inline body (for `local`/`custom` sources) or a path inside
 * the cloned repository (for `repo` source — agent reads the file after fetch).
 */
export type ScriptPayload =
	| { kind: 'inline'; body: string }
	| { kind: 'repo'; repoPath: string };

/** Payload of `agent:log` event. Same shape as the executor's existing log emission. */
export interface AgentLogEvent {
	buildId: string;
	lines: LogLine[];
}

/** Payload of `agent:phase` event. */
export interface AgentPhaseEvent {
	buildId: string;
	phase: BuildPhase;
	action: 'start' | 'end';
}

/** Payload of `agent:complete` event. */
export interface AgentCompleteEvent {
	buildId: string;
	status: 'success' | 'failed';
	exitCode: number;
	repositoryCommits: RepositoryCommitInfo[];
}

/** Payload of `agent:error` event. */
export interface AgentErrorEvent {
	buildId: string;
	code: BuildErrorCode;
	message: string;
}

/** Payload of `build:cancel` event sent from orchestrator to agent. */
export interface BuildCancelEvent {
	buildId: string;
}
