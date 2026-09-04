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
	/**
	 * Target platforms this agent can build (ids from `platforms.json`). Independent of
	 * {@link platform}: a Windows agent may service `win32` and `ps5`. Defaults to the host OS id.
	 */
	platforms: string[];
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
	/**
	 * Whether the agent is willing to accept new builds right now. Omitted means available.
	 * A macOS agent reports false while another user owns the console; builds then stay
	 * queued rather than being dispatched.
	 */
	available?: boolean;
	/** Human-readable reason when {@link available} is false. */
	unavailableReason?: string;
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
	available: boolean;
	unavailableReason?: string;
}

/**
 * An agent the orchestrator has seen at least once, persisted so the UI can offer its platforms
 * for builds while it is offline (e.g. a laptop that is asleep). Keyed by agent name; updated on
 * every registration.
 */
export interface KnownAgent {
	name: string;
	platform: AgentPlatform;
	arch: AgentArch;
	hostname: string;
	platforms: string[];
	labels: string[];
	firstSeenAt: string;
	lastSeenAt: string;
}

/** Connection state of a target platform, derived from live and known agents. */
export type PlatformAvailabilityStatus = 'connected' | 'offline' | 'never-seen';

/** Per-agent detail inside {@link PlatformAvailability}. */
export interface PlatformAgentState {
	name: string;
	connected: boolean;
	/** Only meaningful when connected. */
	available: boolean;
	unavailableReason?: string;
	lastSeenAt: string;
}

/** A platform from `platforms.json` together with the agents able to build it. */
export interface PlatformAvailability {
	id: string;
	label: string;
	status: PlatformAvailabilityStatus;
	agents: PlatformAgentState[];
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
	/**
	 * Ordered snapshot categories declared by `::snapshot-category::` markers in the
	 * test script output, in emission order. Empty if the script declared none (e.g.
	 * a build with no snapshot tests, or a legacy script). Consumed by the server when
	 * parsing the snapshot results tree.
	 */
	snapshotCategories: string[];
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

/**
 * Disk usage of the per-build artifact directories an agent keeps locally.
 *
 * Build artifacts (the CMake install tree) never leave the agent — only logs and test results are
 * uploaded — so nothing prunes them and they accumulate at roughly one full install tree per build.
 * Reported in response to `maintenance:artifact-usage`. Computing it walks the whole artifact
 * tree, which takes seconds rather than milliseconds — callers should treat it as a slow query
 * and render the rest of the agent view without waiting for it.
 */
export interface AgentArtifactUsage {
	/** Total bytes across every per-build artifacts directory. */
	totalBytes: number;
	/** Number of builds that have an artifacts directory on disk. */
	buildCount: number;
	/** Bytes a purge would reclaim, i.e. excluding builds that are currently running. */
	purgeableBytes: number;
	/** Number of artifact directories a purge would delete. */
	purgeableCount: number;
	/** Absolute path of the directory holding per-build artifacts, for display. */
	buildsRoot: string;
}

/**
 * Envelope for orchestrator→agent request/response events that use Socket.IO acknowledgements
 * (the `maintenance:*` events). Agent-side failures are reported in-band rather than by throwing,
 * so the orchestrator can tell a genuine error apart from an unanswered request.
 */
export type AgentAck<T> = { ok: true; data: T } | { ok: false; error: string };

/** Outcome of a `maintenance:purge-artifacts` request. */
export interface AgentPurgeArtifactsResult {
	/** Number of artifact directories deleted. */
	deletedCount: number;
	/** Bytes reclaimed, measured before deletion. */
	freedBytes: number;
	/** Builds skipped because they were running at the time of the purge. */
	skippedBuildIds: string[];
	/** Human-readable failures (e.g. locked files); a non-empty list still means a partial purge ran. */
	errors: string[];
}
