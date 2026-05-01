import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { LogLine, BuildStatus, BuildPhase } from '@banshee-forge/shared';

interface UseBuildSocketOptions {
  buildId: string;
  enabled?: boolean;
  onLog?: (lines: LogLine[]) => void;
  onPhase?: (phase: BuildPhase, action: 'start' | 'end') => void;
  onStatus?: (status: BuildStatus) => void;
  onStats?: (warningCount: number, errorCount: number) => void;
  onComplete?: (summary: {
    durationMs: number;
    warningCount: number;
    errorCount: number;
    phases: BuildPhase[];
  }) => void;
  onError?: (code: string, message: string) => void;
}

export function useBuildSocket({
  buildId,
  enabled = true,
  onLog,
  onPhase,
  onStatus,
  onStats,
  onComplete,
  onError,
}: UseBuildSocketOptions) {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastLineNumber, setLastLineNumber] = useState(0);

  // Store callbacks in refs to avoid reconnection on callback changes
  const callbacksRef = useRef({ onLog, onPhase, onStatus, onStats, onComplete, onError });
  callbacksRef.current = { onLog, onPhase, onStatus, onStats, onComplete, onError };

  useEffect(() => {
    if (!enabled) return;

    // Connect to server (credentials so the session cookie travels on the handshake)
    const socket = io('/', {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      withCredentials: true,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      socket.emit('subscribe_build', buildId);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('build:log', (data: { buildId: string; lines: LogLine[] }) => {
      if (data.buildId === buildId && callbacksRef.current.onLog) {
        callbacksRef.current.onLog(data.lines);
        if (data.lines.length > 0) {
          setLastLineNumber(data.lines[data.lines.length - 1].lineNumber);
        }
      }
    });

    socket.on('build:phase', (data: { buildId: string; phase: BuildPhase; action: 'start' | 'end' }) => {
      if (data.buildId === buildId && callbacksRef.current.onPhase) {
        callbacksRef.current.onPhase(data.phase, data.action);
      }
    });

    socket.on('build:status', (data: { buildId: string; status: BuildStatus }) => {
      if (data.buildId === buildId && callbacksRef.current.onStatus) {
        callbacksRef.current.onStatus(data.status);
      }
    });

    socket.on('build:stats', (data: { buildId: string; warningCount: number; errorCount: number }) => {
      if (data.buildId === buildId && callbacksRef.current.onStats) {
        callbacksRef.current.onStats(data.warningCount, data.errorCount);
      }
    });

    socket.on('build:complete', (data: { buildId: string; status: BuildStatus; summary: any }) => {
      if (data.buildId === buildId) {
        // Update status from the complete event first
        if (callbacksRef.current.onStatus) {
          callbacksRef.current.onStatus(data.status);
        }
        // Then call onComplete
        if (callbacksRef.current.onComplete) {
          callbacksRef.current.onComplete(data.summary);
        }
      }
    });

    socket.on('build:error', (data: { buildId: string; code: string; message: string }) => {
      if (data.buildId === buildId && callbacksRef.current.onError) {
        callbacksRef.current.onError(data.code, data.message);
      }
    });

    return () => {
      socket.emit('unsubscribe_build', buildId);
      socket.disconnect();
    };
  }, [buildId, enabled]);

  return { isConnected, lastLineNumber };
}
