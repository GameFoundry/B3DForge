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
 * Hook to fetch unit test console log
 */
export function useUnitTestLog(buildId: string, enabled = true) {
	return useQuery({
		queryKey: ['tests', buildId, 'unit', 'log'],
		queryFn: () => testsApi.getUnitTestLog(buildId).then(r => r.log),
		enabled: !!buildId && enabled,
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
export function useSnapshotDetails(buildId: string, category: string, testName: string) {
	return useQuery({
		queryKey: ['tests', buildId, 'snapshots', category, testName],
		queryFn: () => testsApi.getSnapshotDetails(buildId, category, testName),
		enabled: !!buildId && !!category && !!testName,
	});
}

/**
 * Hook to fetch snapshot log
 */
export function useSnapshotLog(buildId: string, category: string, testName: string) {
	return useQuery({
		queryKey: ['tests', buildId, 'snapshots', category, testName, 'log'],
		queryFn: () => testsApi.getSnapshotLog(buildId, category, testName).then(r => r.log),
		enabled: !!buildId && !!category && !!testName,
	});
}

/**
 * Hook to compare a snapshot with its reference
 */
export function useSnapshotComparison(buildId: string, category: string, testName: string) {
	return useQuery({
		queryKey: ['tests', buildId, 'snapshots', category, testName, 'compare'],
		queryFn: () => testsApi.compareSnapshot(buildId, category, testName),
		enabled: !!buildId && !!category && !!testName,
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
export function useConfigurationReferences(projectSlug: string, configId: string, platform: string) {
	return useQuery({
		queryKey: ['references', projectSlug, configId, platform],
		queryFn: () => referencesApi.list(projectSlug, configId, platform),
		enabled: !!projectSlug && !!configId && !!platform,
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
			platform,
			category,
			testName,
			buildId,
		}: {
			projectSlug: string;
			configId: string;
			platform: string;
			category: string;
			testName: string;
			buildId: string;
		}) => referencesApi.setReference(projectSlug, configId, platform, category, testName, buildId),
		onSuccess: (_, { projectSlug, configId, platform, buildId, category, testName }) => {
			// Invalidate references cache
			queryClient.invalidateQueries({ queryKey: ['references', projectSlug] });
			queryClient.invalidateQueries({ queryKey: ['references', projectSlug, configId, platform] });
			// Invalidate comparison cache for this test
			queryClient.invalidateQueries({ queryKey: ['tests', buildId, 'snapshots', category, testName, 'compare'] });
			// Refresh the results list so diff percentages update
			queryClient.invalidateQueries({ queryKey: ['tests', buildId], exact: true });
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
			platform,
			category,
			testName,
		}: {
			projectSlug: string;
			configId: string;
			platform: string;
			category: string;
			testName: string;
		}) => referencesApi.deleteReference(projectSlug, configId, platform, category, testName),
		onSuccess: (_, { projectSlug, configId, platform }) => {
			queryClient.invalidateQueries({ queryKey: ['references', projectSlug] });
			queryClient.invalidateQueries({ queryKey: ['references', projectSlug, configId, platform] });
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
			platform,
			destConfigId,
			sourceConfigId,
		}: {
			projectSlug: string;
			platform: string;
			destConfigId: string;
			sourceConfigId: string;
		}) => referencesApi.copyReferences(projectSlug, platform, destConfigId, sourceConfigId),
		onSuccess: (_, { projectSlug, destConfigId, platform }) => {
			queryClient.invalidateQueries({ queryKey: ['references', projectSlug] });
			queryClient.invalidateQueries({ queryKey: ['references', projectSlug, destConfigId, platform] });
		},
	});
}
