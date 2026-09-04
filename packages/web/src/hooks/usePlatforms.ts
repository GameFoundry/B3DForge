import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { platformsApi } from '../api/client';

/**
 * Every platform from platforms.json together with the agents able to build it. Refreshed
 * whenever an agent connects, disconnects, or changes availability.
 */
export function usePlatforms() {
	const queryClient = useQueryClient();

	useEffect(() => {
		const socket = io('/', { path: '/socket.io', transports: ['websocket', 'polling'] });
		const invalidate = () => queryClient.invalidateQueries({ queryKey: ['platforms'] });
		socket.on('agent:connected', invalidate);
		socket.on('agent:disconnected', invalidate);
		socket.on('agent:status-changed', invalidate);
		return () => { socket.disconnect(); };
	}, [queryClient]);

	return useQuery({
		queryKey: ['platforms'],
		queryFn: () => platformsApi.list().then(r => r.platforms),
		refetchInterval: 30_000,
	});
}

export function useKnownAgents() {
	return useQuery({
		queryKey: ['known-agents'],
		queryFn: () => platformsApi.listKnownAgents().then(r => r.agents),
		refetchInterval: 30_000,
	});
}
