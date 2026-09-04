import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import type { QueueStatus } from '@banshee-forge/shared';
import { queueApi } from '../api/client';

/** Live queue status, including why each pending build is still waiting. */
export function useQueueStatus() {
	const queryClient = useQueryClient();

	useEffect(() => {
		const socket = io('/', { path: '/socket.io', transports: ['websocket', 'polling'] });
		socket.on('queue:updated', (status: QueueStatus) => {
			queryClient.setQueryData(['queue'], status);
		});
		return () => { socket.disconnect(); };
	}, [queryClient]);

	return useQuery({
		queryKey: ['queue'],
		queryFn: () => queueApi.getStatus(),
		refetchInterval: 30_000,
	});
}
