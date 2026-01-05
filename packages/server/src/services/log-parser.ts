import type { LogLevel, LogLine } from '@banshee-forge/shared';

export interface ParseResult {
  level: LogLevel;
  phase?: string;
  message: string;
}

// Phase marker: ::phase::NAME
const PHASE_REGEX = /^::phase::(.+)$/;

// Custom markers
const WARNING_MARKER = /^::warning::(.+)$/;
const ERROR_MARKER = /^::error::(.+)$/;

// MSVC and common error patterns
const ERROR_PATTERNS = [
  /\berror\s*:/i,
  /\bError\s*:/,
  /\bERROR\b/,
  /\bfatal\s*:/i,
  /\bFATAL\b/,
  /: error [A-Z]+\d+:/,      // MSVC: ": error C2039:"
  /^error\[\w+\]:/,          // Rust-style: "error[E0425]:"
  /^\s*error:/i,             // CMake: "error:"
];

const WARNING_PATTERNS = [
  /\bwarning\s*:/i,
  /\bWarning\s*:/,
  /\bWARN\b/,
  /: warning [A-Z]+\d+:/,    // MSVC: ": warning C4244:"
  /^warning\[\w+\]:/,        // Rust-style
  /^\s*warning:/i,           // CMake
];

export function parseLine(line: string): ParseResult {
  // Check for phase marker
  const phaseMatch = line.match(PHASE_REGEX);
  if (phaseMatch) {
    return { level: 'phase', phase: phaseMatch[1], message: line };
  }

  // Check for explicit markers
  const warningMatch = line.match(WARNING_MARKER);
  if (warningMatch) {
    return { level: 'warning', message: warningMatch[1] };
  }

  const errorMatch = line.match(ERROR_MARKER);
  if (errorMatch) {
    return { level: 'error', message: errorMatch[1] };
  }

  // Check standard patterns
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(line)) {
      return { level: 'error', message: line };
    }
  }

  for (const pattern of WARNING_PATTERNS) {
    if (pattern.test(line)) {
      return { level: 'warning', message: line };
    }
  }

  return { level: 'info', message: line };
}

// Parse full log text into structured lines
export function parseLog(logText: string, startingPhase = 'init'): { lines: LogLine[], phases: string[] } {
  const lines: LogLine[] = [];
  const phases: string[] = [startingPhase];
  let currentPhase = startingPhase;
  let lineNumber = 0;

  for (const line of logText.split(/\r?\n/)) {
    if (!line.trim()) continue;

    lineNumber++;
    const result = parseLine(line);

    if (result.phase) {
      currentPhase = result.phase;
      if (!phases.includes(currentPhase)) {
        phases.push(currentPhase);
      }
    }

    lines.push({
      timestamp: '', // Not available from static log
      level: result.level,
      phase: currentPhase,
      message: result.message,
      lineNumber,
    });
  }

  return { lines, phases };
}
