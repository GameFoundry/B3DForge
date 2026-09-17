import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Build, BuildConfiguration, Deployment, DeploymentStatus, DeploySchema, LogLine } from '@banshee-forge/shared';
import { getPlatformLabel, isValidBranchName } from '@banshee-forge/shared';
import {
  useDeployEligibility, useBuildDeployments, useCreateDeployment, useRetryDeployment,
  useCancelDeployment, useDeploymentLog, useDeploymentSocket, isDeploymentActive,
} from '../hooks/useDeployments';
import { deploymentsApi } from '../api/client';
import { LogViewer } from './LogViewer';
import { PhaseTimeline } from './PhaseTimeline';

interface DeployPanelProps {
  build: Build;
  configuration?: BuildConfiguration;
}

const STATUS_STYLES: Record<DeploymentStatus, string> = {
  pending: 'bg-gray-700 text-gray-200',
  transferring: 'bg-blue-900/50 text-blue-300',
  running: 'bg-blue-900/50 text-blue-300',
  promoting: 'bg-blue-900/50 text-blue-300',
  success: 'bg-green-900/50 text-green-300',
  failed: 'bg-red-900/50 text-red-300',
  cancelled: 'bg-gray-700 text-gray-400',
};

function DeploymentStatusBadge({ status }: { status: DeploymentStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[status]}`}>
      {isDeploymentActive({ status } as Deployment) && <span className="w-1.5 h-1.5 bg-current rounded-full animate-pulse" />}
      {status}
    </span>
  );
}

/** Initial values of the deploy parameters: the schema defaults. */
function defaultParameters(schema: DeploySchema): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, field] of Object.entries(schema)) {
    values[name] = field.type === 'boolean' ? String(Boolean(field.default)) : field.default === undefined ? '' : String(field.default);
  }
  return values;
}

/** Client-side check of one parameter, mirroring the server's validation; returns a message or null. */
function parameterProblem(name: string, schema: DeploySchema, value: string): string | null {
  const field = schema[name];
  const label = field.label ?? name;
  if (field.type === 'boolean') return null;
  if (!value.trim()) return field.required ? `${label} is required` : null;
  if (field.type === 'select' && field.options && !field.options.includes(value)) return `${label} must be one of ${field.options.join(', ')}`;
  if (field.type === 'string' && field.pattern) {
    try {
      if (!new RegExp(`^(?:${field.pattern})$`).test(value.trim())) return `${label} must match ${field.pattern}`;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Deploy tab of a build: eligibility, the deploy parameters the configuration declares, the
 * optional target branch, and the list of deployments of this build with their live log.
 */
export function DeployPanel({ build, configuration }: DeployPanelProps) {
  const finished = build.status !== 'pending' && build.status !== 'running';
  const { data: eligibility, isLoading: eligibilityLoading } = useDeployEligibility(build.id, finished);
  const { data: deployments = [] } = useBuildDeployments(build.id);
  const createDeployment = useCreateDeployment();
  const retryDeployment = useRetryDeployment();
  const cancelDeployment = useCancelDeployment();

  const schema = useMemo(() => configuration?.deploySchema ?? {}, [configuration]);
  const [parameters, setParameters] = useState<Record<string, string>>(() => defaultParameters(schema));
  const [targetBranch, setTargetBranch] = useState('');
  const [targetEdited, setTargetEdited] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setParameters(defaultParameters(schema)); }, [schema]);

  // The project's deploy branch is the default; a hand-typed branch survives eligibility refreshes.
  useEffect(() => {
    if (eligibility && !targetEdited) setTargetBranch(eligibility.defaultTargetBranch);
  }, [eligibility, targetEdited]);

  // Follow the newest deployment unless the user picked one.
  useEffect(() => {
    if (deployments.length === 0) { setSelectedId(null); return; }
    if (!selectedId || !deployments.some(d => d.id === selectedId)) setSelectedId(deployments[0].id);
  }, [deployments, selectedId]);

  const selected = deployments.find(d => d.id === selectedId) ?? null;
  const parameterProblems = Object.keys(schema).map(name => parameterProblem(name, schema, parameters[name] ?? '')).filter((p): p is string => !!p);
  const trimmedTarget = targetBranch.trim();
  const branchValid = !trimmedTarget || isValidBranchName(trimmedTarget);
  const promotes = !!trimmedTarget && trimmedTarget !== eligibility?.buildBranch;
  const anyActive = deployments.some(isDeploymentActive);
  const canDeploy = !!eligibility?.eligible && parameterProblems.length === 0 && branchValid && !anyActive && !createDeployment.isPending;

  const handleDeploy = async () => {
    setError(null);
    try {
      const deployment = await createDeployment.mutateAsync({
        buildId: build.id,
        input: { targetBranch: trimmedTarget, parameters },
      });
      setSelectedId(deployment.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRetry = async (id: string) => {
    setError(null);
    try {
      const deployment = await retryDeployment.mutateAsync(id);
      setSelectedId(deployment.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCancel = async (id: string) => {
    if (!confirm('Cancel this deployment?')) return;
    setError(null);
    try {
      await cancelDeployment.mutateAsync(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-gray-900 rounded-lg p-6 space-y-6">
      {/* Eligibility and trigger */}
      <div className="bg-gray-800 rounded-lg p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-gray-300">Deploy this build</h3>
            <p className="text-xs text-gray-500 mt-1">
              Transfers the files the build left in its deploy directory to the server and runs the build's <span className="font-mono">deploy.sh</span> there.
              With a target branch, the tested commit of every repository is then pushed (or merged) to it.
              Only a successful build with passing tests can be deployed.
            </p>
          </div>
          <button
            onClick={handleDeploy}
            disabled={!canDeploy}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-medium disabled:opacity-50 flex-shrink-0"
          >
            {createDeployment.isPending ? 'Starting...' : `Deploy ${getPlatformLabel(build.platform)}`}
          </button>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm text-gray-400 flex-shrink-0">Target branch</label>
          <input
            type="text"
            value={targetBranch}
            onChange={e => { setTargetBranch(e.target.value); setTargetEdited(true); }}
            placeholder="none (no promotion)"
            className="w-56 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 font-mono text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
          {!branchValid && <span className="text-xs text-red-400">Not a valid branch name</span>}
          {branchValid && !promotes && <span className="text-xs text-gray-500">{trimmedTarget ? 'Same as the build branch: nothing to promote' : 'Blank: deploy.sh runs, no branch is moved'}</span>}
          {targetEdited && eligibility && trimmedTarget !== eligibility.defaultTargetBranch && (
            <button type="button" onClick={() => { setTargetBranch(eligibility.defaultTargetBranch); setTargetEdited(false); }} className="text-xs text-blue-400 hover:underline">
              Reset to {eligibility.defaultTargetBranch || 'none'}
            </button>
          )}
        </div>

        {Object.keys(schema).length > 0 && (
          <div className="border-t border-gray-700 pt-3 space-y-2">
            {Object.entries(schema).map(([name, field]) => {
              const value = parameters[name] ?? '';
              const problem = parameterProblem(name, schema, value);
              return (
                <div key={name} className="flex items-start gap-3">
                  <label className="text-sm text-gray-400 w-48 flex-shrink-0 pt-1.5" title={name}>{field.label ?? name}{field.required ? ' *' : ''}</label>
                  <div className="flex-1 min-w-0">
                    {field.type === 'boolean' ? (
                      <label className="flex items-center gap-2 pt-1.5">
                        <input type="checkbox" checked={value === 'true'} onChange={e => setParameters(p => ({ ...p, [name]: String(e.target.checked) }))} className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500" />
                        {field.description && <span className="text-xs text-gray-500">{field.description}</span>}
                      </label>
                    ) : field.type === 'select' ? (
                      <select value={value} onChange={e => setParameters(p => ({ ...p, [name]: e.target.value }))} className="w-56 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-gray-100 text-sm">
                        {!field.required && <option value="">(none)</option>}
                        {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
                      </select>
                    ) : (
                      <input type="text" value={value} onChange={e => setParameters(p => ({ ...p, [name]: e.target.value }))} className="w-56 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-gray-100 font-mono text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                    )}
                    {field.type !== 'boolean' && field.description && <p className="text-xs text-gray-500 mt-0.5">{field.description}</p>}
                    {problem && <p className="text-xs text-red-400 mt-0.5">{problem}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!finished && <p className="text-xs text-gray-400">The build is still running.</p>}
        {finished && eligibilityLoading && <p className="text-xs text-gray-400">Checking eligibility...</p>}
        {eligibility && !eligibility.eligible && (
          <ul className="text-xs text-yellow-400 list-disc pl-5 space-y-0.5">
            {eligibility.reasons.map(reason => <li key={reason}>{reason}</li>)}
          </ul>
        )}
        {eligibility?.eligible && anyActive && (
          <p className="text-xs text-gray-400">A deployment of this build is already in progress.</p>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      {/* Deployment list */}
      {deployments.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-2">Deployments</h3>
          <div className="space-y-1">
            {deployments.map(deployment => (
              <button
                key={deployment.id}
                onClick={() => setSelectedId(deployment.id)}
                className={`w-full text-left px-3 py-2 rounded flex items-center gap-3 text-sm ${
                  deployment.id === selectedId ? 'bg-gray-700' : 'bg-gray-800 hover:bg-gray-750'
                }`}
              >
                <DeploymentStatusBadge status={deployment.status} />
                <span className="text-gray-300">attempt {deployment.attempt}</span>
                <span className="text-xs font-mono text-gray-300" title="Target branch">{deployment.targetBranch ? `→ ${deployment.targetBranch}` : 'no promotion'}</span>
                <span className="text-gray-500 text-xs">{new Date(deployment.createdAt).toLocaleString()}</span>
                <span className="text-gray-500 text-xs capitalize">{deployment.triggerType}{deployment.triggeredBy ? ` by ${deployment.triggeredBy}` : ''}</span>
                {Object.entries(deployment.parameters ?? {}).filter(([, v]) => v && v !== 'false').map(([k, v]) => (
                  <span key={k} className="text-xs px-2 py-0.5 bg-indigo-900/50 text-indigo-300 rounded font-mono" title={k}>{v === 'true' ? k : v}</span>
                ))}
                {deployment.promotionScope === 'group' && (
                  <span className="text-xs px-2 py-0.5 bg-gray-700 text-gray-300 rounded" title="Promotion waits for every platform of the build group">group</span>
                )}
                {deployment.pendingReason && isDeploymentActive(deployment) && (
                  <span className="text-xs text-yellow-400 truncate" title={deployment.pendingReason}>{deployment.pendingReason}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <DeploymentDetail
          key={selected.id}
          deployment={selected}
          buildId={build.id}
          onRetry={() => handleRetry(selected.id)}
          onCancel={() => handleCancel(selected.id)}
          retrying={retryDeployment.isPending}
          cancelling={cancelDeployment.isPending}
        />
      )}
    </div>
  );
}

interface DeploymentDetailProps {
  deployment: Deployment;
  buildId: string;
  onRetry: () => void;
  onCancel: () => void;
  retrying: boolean;
  cancelling: boolean;
}

const RESULT_COLORS: Record<string, string> = {
  uploaded: 'text-green-400',
  ok: 'text-green-400',
  success: 'text-green-400',
  exists: 'text-gray-400',
  skipped: 'text-gray-400',
  failed: 'text-red-400',
  error: 'text-red-400',
};

function DeploymentDetail({ deployment, buildId, onRetry, onCancel, retrying, cancelling }: DeploymentDetailProps) {
  const active = isDeploymentActive(deployment);
  const { data: storedLog } = useDeploymentLog(deployment.id);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [loadedStored, setLoadedStored] = useState(false);

  useEffect(() => {
    if (storedLog && !loadedStored) {
      setLoadedStored(true);
      setLogs(prev => (storedLog.lines.length >= prev.length ? storedLog.lines : prev));
    }
  }, [storedLog, loadedStored]);

  const handleLog = useCallback((lines: LogLine[]) => {
    setLogs(prev => {
      const known = new Set(prev.map(l => l.lineNumber));
      const fresh = lines.filter(l => !known.has(l.lineNumber));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }, []);

  useDeploymentSocket({ deploymentId: deployment.id, buildId, onLog: handleLog });

  const running = deployment.phases.find(p => p.status === 'running');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <DeploymentStatusBadge status={deployment.status} />
          <span className="text-sm text-gray-400">
            {deployment.startedAt ? `Started ${new Date(deployment.startedAt).toLocaleString()}` : 'Not started'}
            {deployment.durationMs ? ` · ${(deployment.durationMs / 1000).toFixed(1)}s` : ''}
          </span>
          <span className="text-xs text-gray-500">agent {deployment.agentName}</span>
        </div>
        <div className="flex items-center gap-2">
          {active && (
            <button onClick={onCancel} disabled={cancelling} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded text-sm disabled:opacity-50">
              Cancel
            </button>
          )}
          {(deployment.status === 'failed' || deployment.status === 'cancelled') && (
            <button onClick={onRetry} disabled={retrying} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm disabled:opacity-50">
              Retry
            </button>
          )}
          <a href={deploymentsApi.getRawLogUrl(deployment.id)} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:underline">
            Raw log
          </a>
        </div>
      </div>

      {deployment.error && (
        <div className="bg-red-900/30 border border-red-800 rounded p-3 text-sm text-red-300 whitespace-pre-wrap">{deployment.error}</div>
      )}

      <div className="flex flex-col lg:flex-row gap-4">
        <div className="w-full lg:w-72 flex-shrink-0 space-y-4">
          <PhaseTimeline phases={deployment.phases} currentPhase={running?.name} isRunning={active} />

          {(deployment.results ?? []).length > 0 && (
            <div className="bg-gray-800 rounded-lg p-3">
              <h4 className="text-xs font-medium text-gray-400 mb-2">Results</h4>
              <table className="w-full text-xs">
                <tbody>
                  {deployment.results.map((row, index) => (
                    <tr key={index} title={row.message}>
                      <td className={`pr-2 py-0.5 align-top ${RESULT_COLORS[row.status.toLowerCase()] ?? 'text-yellow-400'}`}>{row.status}</td>
                      <td className="text-gray-300 font-mono break-all py-0.5">{row.item}{row.message ? <span className="text-gray-500 font-sans"> — {row.message}</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(deployment.artifacts ?? []).length > 0 && (
            <div className="bg-gray-800 rounded-lg p-3">
              <h4 className="text-xs font-medium text-gray-400 mb-2">Artifacts</h4>
              <ul className="space-y-1 text-xs">
                {deployment.artifacts.map(artifact => (
                  <li key={artifact.path}>
                    <a href={deploymentsApi.getArtifactUrl(deployment.id, artifact.path)} className="text-blue-400 hover:underline font-mono break-all">
                      {artifact.path}
                    </a>
                    <div className="text-gray-500">{(artifact.size / 1024 ** 2).toFixed(1)} MiB</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {deployment.promotion && (
            <div className="bg-gray-800 rounded-lg p-3">
              <h4 className="text-xs font-medium text-gray-400 mb-2">
                Promotion to {deployment.promotion.targetBranch}{deployment.promotionReused ? ' (reused)' : ''} · {deployment.promotion.status}
              </h4>
              <ul className="space-y-1 text-xs">
                {deployment.promotion.repositories.map(repo => (
                  <li key={repo.path || '.'} className="text-gray-300">
                    <span className="font-medium">{repo.name}</span>
                    <span className="text-gray-500"> {repo.previousTarget.slice(0, 7) || '(new)'} → </span>
                    <span className="font-mono text-blue-400">{repo.newTarget.slice(0, 7)}</span>
                    <span className="text-gray-500"> · {repo.integration}{repo.pushed ? '' : ' · not pushed'}</span>
                  </li>
                ))}
              </ul>
              {deployment.promotion.error && <p className="text-xs text-red-400 mt-2">{deployment.promotion.error}</p>}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 h-[28rem]">
          <LogViewer logs={logs} isLive={active} initialFilter="all" rawLogUrl={deploymentsApi.getRawLogUrl(deployment.id)} />
        </div>
      </div>
    </div>
  );
}
