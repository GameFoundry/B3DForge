import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateBuildInput } from '@banshee-forge/shared';
import { buildsApi } from '../api/client';

export function useBuilds(projectSlug: string, page = 1) {
  return useQuery({
    queryKey: ['builds', projectSlug, page],
    queryFn: () => buildsApi.list(projectSlug, page),
    enabled: !!projectSlug,
  });
}

export function useBuild(id: string) {
  return useQuery({
    queryKey: ['builds', id],
    queryFn: () => buildsApi.get(id),
    enabled: !!id,
  });
}

export function useTriggerBuild() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectSlug, input }: { projectSlug: string; input?: CreateBuildInput }) =>
      buildsApi.trigger(projectSlug, input),
    onSuccess: (_, { projectSlug }) =>
      queryClient.invalidateQueries({ queryKey: ['builds', projectSlug] }),
  });
}

export function useCancelBuild() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => buildsApi.cancel(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['builds'] }),
  });
}

export function useBuildLog(id: string) {
  return useQuery({
    queryKey: ['builds', id, 'log'],
    queryFn: () => buildsApi.getLog(id).then(r => r.log),
    enabled: !!id,
    refetchInterval: 5000, // Poll every 5 seconds for running builds
  });
}

export function useParsedBuildLog(id: string) {
  return useQuery({
    queryKey: ['builds', id, 'log', 'parsed'],
    queryFn: () => buildsApi.getParsedLog(id),
    enabled: !!id,
  });
}
