import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { testsApi, referencesApi } from '../api/client';

/**
 * Hook to fetch test results for a build
 */
export function useTestResults(buildId: string) {
	return useQuery({
		queryKey: ['tests', buildId],
		queryFn: () => testsApi.getResults(buildId),
		enabled: !!buildId,
	});
}

/**
 * Hook to fetch unit test results for a build
 */
export function useUnitTests(buildId: string) {
	return useQuery({
		queryKey: ['tests', buildId, 'unit'],
		queryFn: () => testsApi.getUnitTests(buildId),
		enabled: !!buildId,
	});
}

/**
 * Hook to fetch a specific test suite
 */
export function useTestSuite(buildId: string, suiteId: string) {
	return useQuery({
		queryKey: ['tests', buildId, 'unit', suiteId],
		queryFn: () => testsApi.getTestSuite(buildId, suiteId),
		enabled: !!buildId && !!suiteId,
	});
}

/**
 * Hook to fetch snapshot test results for a build
 */
export function useSnapshotTests(buildId: string) {
	return useQuery({
		queryKey: ['tests', buildId, 'snapshots'],
		queryFn: () => testsApi.getSnapshots(buildId),
		enabled: !!buildId,
	});
}

/**
 * Hook to fetch a specific snapshot test result
 */
export function useSnapshotDetails(buildId: string, testName: string) {
	return useQuery({
		queryKey: ['tests', buildId, 'snapshots', testName],
		queryFn: () => testsApi.getSnapshotDetails(buildId, testName),
		enabled: !!buildId && !!testName,
	});
}

/**
 * Hook to fetch snapshot log
 */
export function useSnapshotLog(buildId: string, testName: string) {
	return useQuery({
		queryKey: ['tests', buildId, 'snapshots', testName, 'log'],
		queryFn: () => testsApi.getSnapshotLog(buildId, testName).then(r => r.log),
		enabled: !!buildId && !!testName,
	});
}

/**
 * Hook to compare a snapshot with its reference
 */
export function useSnapshotComparison(buildId: string, testName: string) {
	return useQuery({
		queryKey: ['tests', buildId, 'snapshots', testName, 'compare'],
		queryFn: () => testsApi.compareSnapshot(buildId, testName),
		enabled: !!buildId && !!testName,
	});
}

/**
 * Hook to list all references for a project
 */
export function useReferences(projectSlug: string) {
	return useQuery({
		queryKey: ['references', projectSlug],
		queryFn: () => referencesApi.listAll(projectSlug),
		enabled: !!projectSlug,
	});
}

/**
 * Hook to list references for a specific configuration
 */
export function useConfigurationReferences(projectSlug: string, configId: string) {
	return useQuery({
		queryKey: ['references', projectSlug, configId],
		queryFn: () => referencesApi.list(projectSlug, configId),
		enabled: !!projectSlug && !!configId,
	});
}

/**
 * Hook to set a screenshot as the new reference
 */
export function useSetReference() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			projectSlug,
			configId,
			testName,
			buildId,
		}: {
			projectSlug: string;
			configId: string;
			testName: string;
			buildId: string;
		}) => referencesApi.setReference(projectSlug, configId, testName, buildId),
		onSuccess: (_, { projectSlug, configId, buildId, testName }) => {
			// Invalidate references cache
			queryClient.invalidateQueries({ queryKey: ['references', projectSlug] });
			queryClient.invalidateQueries({ queryKey: ['references', projectSlug, configId] });
			// Invalidate comparison cache for this test
			queryClient.invalidateQueries({ queryKey: ['tests', buildId, 'snapshots', testName, 'compare'] });
		},
	});
}

/**
 * Hook to delete a reference
 */
export function useDeleteReference() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			projectSlug,
			configId,
			testName,
		}: {
			projectSlug: string;
			configId: string;
			testName: string;
		}) => referencesApi.deleteReference(projectSlug, configId, testName),
		onSuccess: (_, { projectSlug, configId }) => {
			queryClient.invalidateQueries({ queryKey: ['references', projectSlug] });
			queryClient.invalidateQueries({ queryKey: ['references', projectSlug, configId] });
		},
	});
}

/**
 * Hook to copy references between configurations
 */
export function useCopyReferences() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			projectSlug,
			destConfigId,
			sourceConfigId,
		}: {
			projectSlug: string;
			destConfigId: string;
			sourceConfigId: string;
		}) => referencesApi.copyReferences(projectSlug, destConfigId, sourceConfigId),
		onSuccess: (_, { projectSlug, destConfigId }) => {
			queryClient.invalidateQueries({ queryKey: ['references', projectSlug] });
			queryClient.invalidateQueries({ queryKey: ['references', projectSlug, destConfigId] });
		},
	});
}
