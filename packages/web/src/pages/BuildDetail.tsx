import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { LogLine, BuildPhase, BuildStatus } from '@banshee-forge/shared';
import { useBuild, useParsedBuildLog, useCancelBuild } from '../hooks/useBuilds';
import { useBuildSocket } from '../hooks/useBuildSocket';
import { BuildStatusBadge } from '../components/BuildStatusBadge';
import { LogViewer } from '../components/LogViewer';
import { PhaseTimeline } from '../components/PhaseTimeline';

export function BuildDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: build, isLoading, refetch } = useBuild(id!);
  const { data: parsedLog, isLoading: isLogLoading } = useParsedBuildLog(id!);
  const cancelBuild = useCancelBuild();

  // Live state
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [phases, setPhases] = useState<BuildPhase[]>([]);
  const [currentPhase, setCurrentPhase] = useState<string | undefined>();
  const [warningCount, setWarningCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [liveStatus, setLiveStatus] = useState<BuildStatus | null>(null);

  const isLive = build?.status === 'running' || build?.status === 'pending';

  // Initialize from parsed log data
  useEffect(() => {
    if (parsedLog && !isLive) {
      setLogs(parsedLog.lines);
      setPhases(parsedLog.phases.map((name) => ({
        name,
        status: 'success' as const,
        durationMs: 0,
      })));
    }
  }, [parsedLog, isLive]);

  // Initialize from build data
  useEffect(() => {
    if (build) {
      if (build.phases) {
        setPhases(build.phases);
      }
      setWarningCount(build.warningCount ?? 0);
      setErrorCount(build.errorCount ?? 0);
    }
  }, [build]);

  // Socket callbacks
  const handleLog = useCallback((newLines: LogLine[]) => {
    setLogs((prev) => [...prev, ...newLines]);
  }, []);

  const handlePhase = useCallback((phase: BuildPhase, action: 'start' | 'end') => {
    if (action === 'start') {
      setCurrentPhase(phase.name);
      setPhases((prev) => {
        const existing = prev.find((p) => p.name === phase.name);
        if (existing) {
          return prev.map((p) =>
            p.name === phase.name ? { ...p, status: 'running' } : p
          );
        }
        return [...prev, { ...phase, status: 'running' }];
      });
    } else {
      setPhases((prev) =>
        prev.map((p) =>
          p.name === phase.name ? { ...phase, status: 'success' } : p
        )
      );
    }
  }, []);

  const handleStatus = useCallback((status: BuildStatus) => {
    setLiveStatus(status);
    if (status !== 'running' && status !== 'pending') {
      refetch();
    }
  }, [refetch]);

  const handleStats = useCallback((warnings: number, errors: number) => {
    setWarningCount(warnings);
    setErrorCount(errors);
  }, []);

  const handleComplete = useCallback(() => {
    refetch();
  }, [refetch]);

  const { isConnected } = useBuildSocket({
    buildId: id!,
    enabled: isLive,
    onLog: handleLog,
    onPhase: handlePhase,
    onStatus: handleStatus,
    onStats: handleStats,
    onComplete: handleComplete,
  });

  const handleCancel = async () => {
    if (id && confirm('Are you sure you want to cancel this build?')) {
      await cancelBuild.mutateAsync(id);
    }
  };

  const displayStatus = liveStatus ?? build?.status;
  const displayWarningCount = isLive ? warningCount : (build?.warningCount ?? 0);
  const displayErrorCount = isLive ? errorCount : (build?.errorCount ?? 0);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  if (!build) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold text-gray-300 mb-2">Build not found</h2>
        <Link to="/" className="text-blue-400 hover:underline">
          Return to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link
            to={`/projects/${build.projectSlug}`}
            className="text-blue-400 hover:underline text-sm mb-2 inline-block"
          >
            &larr; Back to project
          </Link>
          <h1 className="text-2xl font-bold text-gray-100">Build #{build.buildNumber}</h1>
          <p className="text-gray-400 font-mono text-sm">
            {build.gitBranch} @ {build.gitCommit?.slice(0, 7) ?? 'HEAD'}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {isLive && (
            <>
              {isConnected ? (
                <span className="flex items-center gap-2 text-sm text-green-400">
                  <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                  Connected
                </span>
              ) : (
                <span className="flex items-center gap-2 text-sm text-yellow-400">
                  <span className="w-2 h-2 bg-yellow-500 rounded-full" />
                  Connecting...
                </span>
              )}
              <button
                onClick={handleCancel}
                disabled={cancelBuild.isPending}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded text-sm disabled:opacity-50"
              >
                Cancel Build
              </button>
            </>
          )}
          <BuildStatusBadge status={displayStatus ?? 'pending'} />
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-sm text-gray-400">Trigger</div>
          <div className="text-lg font-semibold text-gray-100 capitalize">{build.triggerType}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-sm text-gray-400">Duration</div>
          <div className="text-lg font-semibold text-gray-100">
            {build.durationMs ? `${(build.durationMs / 1000).toFixed(1)}s` : '-'}
          </div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-sm text-gray-400">Warnings</div>
          <div className={`text-lg font-semibold ${displayWarningCount > 0 ? 'text-yellow-400' : 'text-gray-100'}`}>
            {displayWarningCount}
          </div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-sm text-gray-400">Errors</div>
          <div className={`text-lg font-semibold ${displayErrorCount > 0 ? 'text-red-400' : 'text-gray-100'}`}>
            {displayErrorCount}
          </div>
        </div>
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Phase Timeline */}
        <div className="lg:col-span-1">
          <PhaseTimeline
            phases={phases}
            currentPhase={currentPhase}
            isRunning={displayStatus === 'running'}
          />

          {/* Build Info */}
          <div className="bg-gray-800 rounded-lg p-4 mt-4">
            <h3 className="text-sm font-medium text-gray-300 mb-3">Build Info</h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">Started</dt>
                <dd className="text-gray-300">
                  {build.startedAt ? new Date(build.startedAt).toLocaleString() : '-'}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Finished</dt>
                <dd className="text-gray-300">
                  {build.finishedAt ? new Date(build.finishedAt).toLocaleString() : '-'}
                </dd>
              </div>
              {build.config && Object.keys(build.config).length > 0 && (
                <>
                  <div className="border-t border-gray-700 pt-2 mt-2">
                    <dt className="text-gray-500 mb-1">Configuration</dt>
                    <dd className="text-gray-300 font-mono text-xs">
                      {Object.entries(build.config).map(([key, value]) => (
                        <div key={key}>
                          {key}: {String(value)}
                        </div>
                      ))}
                    </dd>
                  </div>
                </>
              )}
            </dl>
          </div>
        </div>

        {/* Log Viewer */}
        <div className="lg:col-span-2 h-[600px]">
          {isLogLoading && !isLive ? (
            <div className="flex items-center justify-center h-full bg-gray-900 rounded-lg">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
            </div>
          ) : (
            <LogViewer
              logs={logs}
              isLive={isLive}
              initialFilter="all"
            />
          )}
        </div>
      </div>
    </div>
  );
}
