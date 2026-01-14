import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, Socket } from 'socket.io-client';

/**
 * Hook that listens for builds:updated socket events and invalidates the builds query.
 * Use this on pages that display build lists to keep them in sync.
 */
export function useBuildsUpdates(projectSlug?: string) {
  const queryClient = useQueryClient();
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // Connect to server
    const socket = io('/', {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('builds:updated', () => {
      // Invalidate all builds queries to refresh the list
      if (projectSlug) {
        queryClient.invalidateQueries({ queryKey: ['builds', projectSlug] });
      } else {
        queryClient.invalidateQueries({ queryKey: ['builds'] });
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [queryClient, projectSlug]);
}
