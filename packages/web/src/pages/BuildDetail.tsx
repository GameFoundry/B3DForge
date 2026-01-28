import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { LogLine, BuildPhase, BuildStatus } from '@banshee-forge/shared';
import { useBuild, useParsedBuildLog, useCancelBuild } from '../hooks/useBuilds';
import { useBuildSocket } from '../hooks/useBuildSocket';
import { useTestResults } from '../hooks/useTestResults';
import { BuildStatusBadge } from '../components/BuildStatusBadge';
import { LogViewer } from '../components/LogViewer';
import { PhaseTimeline } from '../components/PhaseTimeline';
import { TestResultsTab } from '../components/TestResultsTab';

type MainTab = 'logs' | 'tests';

export function BuildDetail() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { data: build, isLoading, isFetching: isBuildFetching, refetch } = useBuild(id!);
  const { data: parsedLog, isLoading: isLogLoading, isFetching: isLogFetching, refetch: refetchLog } = useParsedBuildLog(id!);
  const { data: testResults } = useTestResults(id!);
  const cancelBuild = useCancelBuild();

  // Tab state
  const [activeTab, setActiveTab] = useState<MainTab>('logs');

  // Live state
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [phases, setPhases] = useState<BuildPhase[]>([]);
  const [currentPhase, setCurrentPhase] = useState<string | undefined>();
  const [warningCount, setWarningCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [liveStatus, setLiveStatus] = useState<BuildStatus | null>(null);

  // Track which build ID we've loaded data for to prevent using stale cached data
  const loadedLogForBuildId = useRef<string | null>(null);
  const loadedPhasesForBuildId = useRef<string | null>(null);
  const receivedLivePhaseEvents = useRef(false);

  // Check both build data status and live status from socket
  const effectiveStatus = liveStatus ?? build?.status;
  const isLive = effectiveStatus === 'running' || effectiveStatus === 'pending';

  // Reset state when build ID changes
  useEffect(() => {
    // Reset tracking refs - new build means we need fresh data
    loadedLogForBuildId.current = null;
    loadedPhasesForBuildId.current = null;
    receivedLivePhaseEvents.current = false;

    // Reset state
    setLogs([]);
    setPhases([]);
    setCurrentPhase(undefined);
    setWarningCount(0);
    setErrorCount(0);
    setLiveStatus(null);

    // Force refetch fresh data for this build
    refetch();
    refetchLog();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initialize from parsed log data - only if it's for the current build and not fetching
  useEffect(() => {
    // Wait for fetch to complete to avoid loading stale cached data
    if (isLogFetching) return;

    // Only load if we have data and we haven't loaded for this build yet
    if (parsedLog && id && loadedLogForBuildId.current !== id) {
      loadedLogForBuildId.current = id;
      setLogs(parsedLog.lines);
    }
  }, [parsedLog, id, isLogFetching]);

  // Initialize phases from build data - only if it's for the current build and not fetching
  useEffect(() => {
    // Wait for fetch to complete to avoid loading stale cached data
    if (isBuildFetching) return;

    // Only load if we have data, it's for the current build, and we haven't loaded yet
    if (build && build.id === id && loadedPhasesForBuildId.current !== id && !receivedLivePhaseEvents.current) {
      loadedPhasesForBuildId.current = id;
      if (build.phases && build.phases.length > 0) {
        setPhases(build.phases);
        // Find currently running phase
        const running = build.phases.find(p => p.status === 'running');
        if (running) {
          setCurrentPhase(running.name);
        }
      }
      setWarningCount(build.warningCount ?? 0);
      setErrorCount(build.errorCount ?? 0);
    } else if (build && build.id === id && !isBuildFetching) {
      // Always update counts even if we've loaded phases
      setWarningCount(build.warningCount ?? 0);
      setErrorCount(build.errorCount ?? 0);
    }
  }, [build, id, isBuildFetching]);

  // Socket callbacks
  const handleLog = useCallback((newLines: LogLine[]) => {
    setLogs((prev) => {
      // Filter out lines we already have (based on line number)
      const existingLineNumbers = new Set(prev.map(l => l.lineNumber));
      const uniqueNewLines = newLines.filter(l => !existingLineNumbers.has(l.lineNumber));
      if (uniqueNewLines.length === 0) return prev;
      return [...prev, ...uniqueNewLines];
    });
  }, []);

  const handlePhase = useCallback((phase: BuildPhase, action: 'start' | 'end') => {
    receivedLivePhaseEvents.current = true;

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
      setCurrentPhase(undefined);
      setPhases((prev) => {
        const existing = prev.find((p) => p.name === phase.name);
        if (existing) {
          return prev.map((p) =>
            p.name === phase.name ? { ...phase } : p
          );
        }
        // Phase wasn't in the list (missed the start event), add it
        return [...prev, { ...phase }];
      });
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

  const handleComplete = useCallback(async () => {
    // Small delay to let server finish saving final state
    await new Promise(resolve => setTimeout(resolve, 500));

    // Refetch build data
    const freshBuild = await refetch();

    // Only update phases if we got valid data with phases
    if (freshBuild.data?.phases && freshBuild.data.phases.length > 0) {
      setPhases(freshBuild.data.phases);
    }
    setCurrentPhase(undefined);

    // Invalidate and refetch the log to get any final lines
    queryClient.invalidateQueries({ queryKey: ['builds', id, 'log', 'parsed'] });
    const freshLog = await refetchLog();

    // Only update logs if we got more lines than we have
    if (freshLog.data?.lines && freshLog.data.lines.length > 0) {
      setLogs(prev => {
        // Keep whichever has more lines
        if (freshLog.data!.lines.length >= prev.length) {
          return freshLog.data!.lines;
        }
        return prev;
      });
    }
  }, [refetch, refetchLog, queryClient, id]);

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
          <div className="flex items-center gap-2 mt-1">
            <p className="text-gray-400 font-mono text-sm">
              {build.gitBranch} @ {build.gitCommit?.slice(0, 7) ?? 'HEAD'}
            </p>
            {build.cleanBuild ? (
              <span className="text-xs px-2 py-0.5 bg-orange-900/50 text-orange-300 rounded">
                Clean build
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 bg-cyan-900/50 text-cyan-300 rounded">
                Incremental
              </span>
            )}
          </div>
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

      {/* Main content layout */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Phase Timeline - fixed width sidebar */}
        <div className="w-full lg:w-72 xl:w-80 flex-shrink-0">
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
              <div className="flex justify-between">
                <dt className="text-gray-500">Workspace</dt>
                <dd className={`${build.cleanBuild ? 'text-orange-300' : 'text-cyan-300'}`}>
                  {build.cleanBuild ? 'Clean (fresh)' : 'Incremental (reused)'}
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

        {/* Log/Tests Content - takes remaining space */}
        <div className="flex-1 min-w-0 flex flex-col h-[calc(100vh-22rem)]">
          {/* Tab Navigation */}
          <div className="border-b border-gray-700 mb-4">
            <nav className="-mb-px flex space-x-6">
              <button
                onClick={() => setActiveTab('logs')}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'logs'
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-600'
                }`}
              >
                Logs
              </button>
              <button
                onClick={() => setActiveTab('tests')}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'tests'
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-600'
                }`}
              >
                Tests
                {testResults?.unitTests?.summary && (
                  <span className={`ml-2 px-2 py-0.5 text-xs rounded-full ${
                    testResults.unitTests.summary.failed > 0
                      ? 'bg-red-900/50 text-red-300'
                      : 'bg-green-900/50 text-green-300'
                  }`}>
                    {testResults.unitTests.summary.passed}/{testResults.unitTests.summary.total}
                  </span>
                )}
              </button>
            </nav>
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-hidden">
            {activeTab === 'logs' && (
              isLogLoading && !isLive ? (
                <div className="flex items-center justify-center h-full bg-gray-900 rounded-lg">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
                </div>
              ) : (
                <LogViewer
                  logs={logs}
                  isLive={isLive}
                  initialFilter="all"
                />
              )
            )}

            {activeTab === 'tests' && build && (
              <div className="h-full overflow-y-auto bg-gray-900 rounded-lg p-4">
                <TestResultsTab
                  buildId={build.id}
                  projectSlug={build.projectSlug}
                  configurationId={build.configurationId || 'default'}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
