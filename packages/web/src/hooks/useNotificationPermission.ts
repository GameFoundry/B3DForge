import { useCallback, useState } from 'react';

export type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

function getPermission(): PermissionState {
  if (!('Notification' in window))
    return 'unsupported';
  return Notification.permission as PermissionState;
}

/**
 * Hook that exposes browser notification permission state and a requestPermission callback.
 * The callback must be called from a user gesture (click) since browsers block programmatic
 * permission requests.
 */
export function useNotificationPermission() {
  const [permission, setPermission] = useState<PermissionState>(getPermission);

  const requestPermission = useCallback(async () => {
    if (!('Notification' in window)) return;
    const result = await Notification.requestPermission();
    setPermission(result as PermissionState);
  }, []);

  return { permission, requestPermission };
}
