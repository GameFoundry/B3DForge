import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { toast } from 'sonner';
import type { BuildStatus, TriggerType, TestSummary } from '@banshee-forge/shared';

interface BuildStartedEvent {
  buildId: string;
  projectSlug: string;
  projectName: string;
  buildNumber: number;
  triggerType: TriggerType;
  configurationName: string;
}

interface BuildFinishedEvent {
  buildId: string;
  projectSlug: string;
  projectName: string;
  buildNumber: number;
  triggerType: TriggerType;
  configurationName: string;
  status: BuildStatus;
  durationMs?: number;
  warningCount: number;
  errorCount: number;
  testSummary?: TestSummary;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60)
    return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function sendOsNotification(title: string, body: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted')
    return;

  new Notification(title, { body, icon: '/favicon.ico' });
}

/**
 * Global hook that listens for build start/finish events and shows toast notifications
 * plus OS-level notifications via the Web Notifications API.
 * Must stay mounted at all times (place in Layout, not in a conditionally-rendered component).
 */
export function useBuildNotifications() {
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io('/', {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('build:started', (data: BuildStartedEvent) => {
      const title = `Build #${data.buildNumber} started`;
      const body = `${data.projectName} (${data.configurationName})`;

      toast.info(title, {
        description: body,
        duration: 5000,
      });
      sendOsNotification(title, body);
    });

    socket.on('build:finished', (data: BuildFinishedEvent) => {
      const duration = data.durationMs ? ` in ${formatDuration(data.durationMs)}` : '';

      if (data.status === 'success') {
        const warnings = data.warningCount > 0 ? ` with ${data.warningCount} warning${data.warningCount !== 1 ? 's' : ''}` : '';
        const title = `Build #${data.buildNumber} succeeded${warnings}`;
        const body = `${data.projectName} (${data.configurationName})${duration}`;

        toast.success(title, { description: body, duration: 6000 });
        sendOsNotification(title, body);
      } else {
        const errors = data.errorCount > 0 ? ` with ${data.errorCount} error${data.errorCount !== 1 ? 's' : ''}` : '';
        const title = `Build #${data.buildNumber} failed${errors}`;
        const body = `${data.projectName} (${data.configurationName})${duration}`;

        toast.error(title, { description: body, duration: 8000 });
        sendOsNotification(title, body);
      }
    });

    return () => {
      socket.disconnect();
    };
  }, []);
}
