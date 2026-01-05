import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateProjectInput,
  UpdateProjectInput,
  ScriptType,
  CreateConfigurationInput,
  UpdateConfigurationInput,
} from '@banshee-forge/shared';
import { projectsApi } from '../api/client';

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsApi.list().then(r => r.projects),
  });
}

export function useProject(slug: string) {
  return useQuery({
    queryKey: ['projects', slug],
    queryFn: () => projectsApi.get(slug),
    enabled: !!slug,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => projectsApi.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, input }: { slug: string; input: UpdateProjectInput }) =>
      projectsApi.update(slug, input),
    onSuccess: (_, { slug }) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects', slug] });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => projectsApi.delete(slug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

// ============================================
// Configuration hooks
// ============================================

export function useConfigurations(slug: string) {
  return useQuery({
    queryKey: ['projects', slug, 'configurations'],
    queryFn: () => projectsApi.listConfigurations(slug).then(r => r.configurations),
    enabled: !!slug,
  });
}

export function useConfiguration(slug: string, configId: string) {
  return useQuery({
    queryKey: ['projects', slug, 'configurations', configId],
    queryFn: () => projectsApi.getConfiguration(slug, configId),
    enabled: !!slug && !!configId,
  });
}

export function useCreateConfiguration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, input }: { slug: string; input: CreateConfigurationInput }) =>
      projectsApi.createConfiguration(slug, input),
    onSuccess: (_, { slug }) => {
      queryClient.invalidateQueries({ queryKey: ['projects', slug, 'configurations'] });
      queryClient.invalidateQueries({ queryKey: ['projects', slug] });
    },
  });
}

export function useUpdateConfiguration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      slug,
      configId,
      input,
    }: {
      slug: string;
      configId: string;
      input: UpdateConfigurationInput;
    }) => projectsApi.updateConfiguration(slug, configId, input),
    onSuccess: (_, { slug, configId }) => {
      queryClient.invalidateQueries({ queryKey: ['projects', slug, 'configurations', configId] });
      queryClient.invalidateQueries({ queryKey: ['projects', slug, 'configurations'] });
      queryClient.invalidateQueries({ queryKey: ['projects', slug] });
    },
  });
}

export function useDeleteConfiguration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, configId }: { slug: string; configId: string }) =>
      projectsApi.deleteConfiguration(slug, configId),
    onSuccess: (_, { slug }) => {
      queryClient.invalidateQueries({ queryKey: ['projects', slug, 'configurations'] });
      queryClient.invalidateQueries({ queryKey: ['projects', slug] });
    },
  });
}

// Configuration build script hooks
export function useConfigurationBuildScript(slug: string, configId: string) {
  return useQuery({
    queryKey: ['projects', slug, 'configurations', configId, 'scripts', 'build'],
    queryFn: () => projectsApi.getConfigurationBuildScript(slug, configId),
    enabled: !!slug && !!configId,
  });
}

export function useUpdateConfigurationBuildScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, configId, script }: { slug: string; configId: string; script: string }) =>
      projectsApi.updateConfigurationBuildScript(slug, configId, script),
    onSuccess: (_, { slug, configId }) => {
      queryClient.invalidateQueries({
        queryKey: ['projects', slug, 'configurations', configId, 'scripts', 'build'],
      });
    },
  });
}

// Configuration test script hooks
export function useConfigurationTestScript(slug: string, configId: string) {
  return useQuery({
    queryKey: ['projects', slug, 'configurations', configId, 'scripts', 'test'],
    queryFn: () => projectsApi.getConfigurationTestScript(slug, configId),
    enabled: !!slug && !!configId,
  });
}

export function useUpdateConfigurationTestScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      slug,
      configId,
      script,
      scriptType,
    }: {
      slug: string;
      configId: string;
      script: string;
      scriptType: ScriptType;
    }) => projectsApi.updateConfigurationTestScript(slug, configId, script, scriptType),
    onSuccess: (_, { slug, configId }) => {
      queryClient.invalidateQueries({
        queryKey: ['projects', slug, 'configurations', configId, 'scripts', 'test'],
      });
      queryClient.invalidateQueries({ queryKey: ['projects', slug, 'configurations', configId] });
    },
  });
}

export function useDeleteConfigurationTestScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, configId }: { slug: string; configId: string }) =>
      projectsApi.deleteConfigurationTestScript(slug, configId),
    onSuccess: (_, { slug, configId }) => {
      queryClient.invalidateQueries({
        queryKey: ['projects', slug, 'configurations', configId, 'scripts', 'test'],
      });
      queryClient.invalidateQueries({ queryKey: ['projects', slug, 'configurations', configId] });
    },
  });
}

// Configuration fetch script hooks (always local bash)
export function useConfigurationFetchScript(slug: string, configId: string) {
  return useQuery({
    queryKey: ['projects', slug, 'configurations', configId, 'scripts', 'fetch'],
    queryFn: () => projectsApi.getConfigurationFetchScript(slug, configId),
    enabled: !!slug && !!configId,
  });
}

export function useUpdateConfigurationFetchScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, configId, script }: { slug: string; configId: string; script: string }) =>
      projectsApi.updateConfigurationFetchScript(slug, configId, script),
    onSuccess: (_, { slug, configId }) => {
      queryClient.invalidateQueries({
        queryKey: ['projects', slug, 'configurations', configId, 'scripts', 'fetch'],
      });
    },
  });
}

