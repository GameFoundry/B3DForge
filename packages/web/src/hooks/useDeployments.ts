import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { io, Socket } from 'socket.io-client';
import type { CreateDeploymentInput, Deployment, LogLine } from '@banshee-forge/shared';
import { deploymentsApi } from '../api/client';

const ACTIVE_STATUSES = new Set<Deployment['status']>(['pending', 'transferring', 'running', 'promoting']);

export function isDeploymentActive(deployment: Deployment): boolean {
  return ACTIVE_STATUSES.has(deployment.status);
}

export function useDeployEligibility(buildId: string, enabled = true) {
  return useQuery({
    queryKey: ['deployments', 'eligibility', buildId],
    queryFn: () => deploymentsApi.getEligibility(buildId),
    enabled: !!buildId && enabled,
    staleTime: 0,
  });
}

export function useBuildDeployments(buildId: string) {
  return useQuery({
    queryKey: ['deployments', 'build', buildId],
    queryFn: () => deploymentsApi.listForBuild(buildId).then(r => r.deployments),
    enabled: !!buildId,
    staleTime: 0,
    // Socket events refresh the list too; the interval covers a dropped connection.
    refetchInterval: query => (query.state.data?.some(isDeploymentActive) ? 5000 : false),
  });
}

export function useProjectDeployments(projectSlug: string) {
  return useQuery({
    queryKey: ['deployments', 'project', projectSlug],
    queryFn: () => deploymentsApi.listForProject(projectSlug).then(r => r.deployments),
    enabled: !!projectSlug,
  });
}

export function useDeployment(id: string | null) {
  return useQuery({
    queryKey: ['deployments', id],
    queryFn: () => deploymentsApi.get(id!),
    enabled: !!id,
    staleTime: 0,
  });
}

export function useDeploymentLog(id: string | null) {
  return useQuery({
    queryKey: ['deployments', id, 'log'],
    queryFn: () => deploymentsApi.getParsedLog(id!),
    enabled: !!id,
    staleTime: 0,
  });
}

export function useCreateDeployment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ buildId, input }: { buildId: string; input?: CreateDeploymentInput }) =>
      deploymentsApi.create(buildId, input),
    onSuccess: (_, { buildId }) => {
      queryClient.invalidateQueries({ queryKey: ['deployments', 'build', buildId] });
      queryClient.invalidateQueries({ queryKey: ['deployments', 'eligibility', buildId] });
    },
  });
}

export function useRetryDeployment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deploymentsApi.retry(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['deployments'] }),
  });
}

export function useCancelDeployment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deploymentsApi.cancel(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['deployments'] }),
  });
}

interface UseDeploymentSocketOptions {
  /** Deployment whose log room to join; null joins none but still receives list updates. */
  deploymentId: string | null;
  buildId?: string;
  onLog?: (lines: LogLine[]) => void;
  onUpdated?: (deployment: Deployment) => void;
}

/**
 * Live deployment updates. `deployment:updated` is broadcast to every client and refreshes the
 * cached deployment lists; `deployment:log` only reaches subscribers of that deployment's room.
 */
export function useDeploymentSocket({ deploymentId, buildId, onLog, onUpdated }: UseDeploymentSocketOptions) {
  const queryClient = useQueryClient();
  const socketRef = useRef<Socket | null>(null);
  const callbacksRef = useRef({ onLog, onUpdated });
  callbacksRef.current = { onLog, onUpdated };

  useEffect(() => {
    const socket = io('/', {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      withCredentials: true,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      if (deploymentId) socket.emit('subscribe_deployment', deploymentId);
    });

    socket.on('deployment:log', (data: { deploymentId: string; lines: LogLine[] }) => {
      if (data.deploymentId === deploymentId) callbacksRef.current.onLog?.(data.lines);
    });

    socket.on('deployment:updated', (data: { projectSlug: string; buildId: string; deployment: Deployment }) => {
      queryClient.setQueryData(['deployments', data.deployment.id], data.deployment);
      queryClient.invalidateQueries({ queryKey: ['deployments', 'build', data.buildId] });
      queryClient.invalidateQueries({ queryKey: ['deployments', 'project', data.projectSlug] });
      if (data.buildId === buildId) queryClient.invalidateQueries({ queryKey: ['deployments', 'eligibility', data.buildId] });
      if (data.deployment.id === deploymentId) callbacksRef.current.onUpdated?.(data.deployment);
    });

    return () => {
      if (deploymentId) socket.emit('unsubscribe_deployment', deploymentId);
      socket.disconnect();
    };
  }, [deploymentId, buildId, queryClient]);
}
