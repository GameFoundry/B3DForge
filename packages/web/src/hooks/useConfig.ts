import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServerConfigUpdate } from '@banshee-forge/shared';
import { configApi } from '../api/client';

export function useServerConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => configApi.get(),
  });
}

export function useUpdateServerConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (updates: ServerConfigUpdate) => configApi.update(updates),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['config'] }),
  });
}

export function useValidateDataPath() {
  return useMutation({
    mutationFn: (dataPath: string) => configApi.validate(dataPath),
  });
}
