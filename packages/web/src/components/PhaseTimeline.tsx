import type { BuildPhase } from '@banshee-forge/shared';

interface PhaseTimelineProps {
  phases: BuildPhase[];
  currentPhase?: string;
  isRunning?: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function getPhaseIcon(status: BuildPhase['status']) {
  switch (status) {
    case 'success':
      return (
        <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
      );
    case 'failed':
      return (
        <svg className="w-4 h-4 text-red-400" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      );
    case 'running':
      return (
        <svg className="w-4 h-4 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );
    case 'skipped':
      return (
        <svg className="w-4 h-4 text-gray-500" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 000 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
        </svg>
      );
    default:
      return (
        <div className="w-4 h-4 rounded-full border-2 border-gray-600" />
      );
  }
}

function getStatusColor(status: BuildPhase['status']) {
  switch (status) {
    case 'success':
      return 'border-green-500 bg-green-500/10';
    case 'failed':
      return 'border-red-500 bg-red-500/10';
    case 'running':
      return 'border-blue-500 bg-blue-500/10';
    case 'skipped':
      return 'border-gray-600 bg-gray-600/10';
    default:
      return 'border-gray-700 bg-gray-700/10';
  }
}

export function PhaseTimeline({ phases, currentPhase, isRunning = false }: PhaseTimelineProps) {
  // Calculate total duration
  const totalDuration = phases.reduce((sum, phase) => sum + (phase.durationMs ?? 0), 0);

  // Find running phase if not explicitly provided
  const activePhase = currentPhase ?? phases.find((p) => p.status === 'running')?.name;

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-gray-300">Build Phases</h3>
        {totalDuration > 0 && (
          <span className="text-sm text-gray-500">
            Total: {formatDuration(totalDuration)}
          </span>
        )}
      </div>

      <div className="space-y-3">
        {phases.map((phase, index) => {
          const isActive = phase.name === activePhase && isRunning;
          const statusColor = getStatusColor(phase.status);

          return (
            <div
              key={phase.name}
              className={`relative flex items-start gap-3 p-3 rounded-lg border ${statusColor} ${
                isActive ? 'ring-2 ring-blue-500/50' : ''
              }`}
            >
              {/* Connector line */}
              {index < phases.length - 1 && (
                <div className="absolute left-[1.35rem] top-[2.75rem] w-0.5 h-[calc(100%-0.5rem)] bg-gray-700" />
              )}

              {/* Icon */}
              <div className="flex-shrink-0 mt-0.5">
                {getPhaseIcon(phase.status)}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-gray-100">{phase.name}</span>
                  {phase.durationMs !== undefined && phase.durationMs > 0 && (
                    <span className="text-sm text-gray-500">
                      {formatDuration(phase.durationMs)}
                    </span>
                  )}
                </div>

                {/* Stats row */}
                {(phase.warningCount !== undefined && phase.warningCount > 0) ||
                (phase.errorCount !== undefined && phase.errorCount > 0) ? (
                  <div className="flex items-center gap-4 mt-1 text-sm">
                    {phase.warningCount !== undefined && phase.warningCount > 0 && (
                      <span className="text-yellow-400">
                        {phase.warningCount} warning{phase.warningCount !== 1 ? 's' : ''}
                      </span>
                    )}
                    {phase.errorCount !== undefined && phase.errorCount > 0 && (
                      <span className="text-red-400">
                        {phase.errorCount} error{phase.errorCount !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}

        {phases.length === 0 && (
          <div className="text-gray-500 text-center py-4">
            No phases recorded yet
          </div>
        )}
      </div>
    </div>
  );
}
