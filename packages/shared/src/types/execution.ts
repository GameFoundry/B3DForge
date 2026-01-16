import type { BuildStatus, BuildPhase } from './build.js';

// Log levels for parsed output
export type LogLevel = 'info' | 'warning' | 'error' | 'phase' | 'trace';

// Parsed log line
export interface LogLine {
  timestamp: string;
  level: LogLevel;
  phase: string;
  message: string;
  lineNumber: number;
}

// WebSocket events (Server -> Client)
export interface BuildLogEvent {
  buildId: string;
  lines: LogLine[];  // Batched for efficiency
}

export interface BuildStatusEvent {
  buildId: string;
  status: BuildStatus;
  phase?: string;
  warningCount?: number;
  errorCount?: number;
}

export interface BuildPhaseEvent {
  buildId: string;
  phase: BuildPhase;
}

export interface BuildCompleteEvent {
  buildId: string;
  status: BuildStatus;
  summary: {
    durationMs: number;
    warningCount: number;
    errorCount: number;
    phases: BuildPhase[];
  };
}

// Queue status
export interface QueuedBuild {
  buildId: string;
  projectSlug: string;
  priority: number;
  queuedAt: string;
}

export interface QueueStatus {
  queue: QueuedBuild[];
  activeBuildId: string | null;
}

// Build error types
export type BuildErrorCode =
  | 'SCRIPT_NOT_FOUND'
  | 'EXECUTION_FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'WORKSPACE_ERROR';

export interface BuildError {
  code: BuildErrorCode;
  message: string;
  details?: string;
}
