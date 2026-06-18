/**
 * useLiveSyncStatus — Global hook that exposes the WebSocket live-sync
 * connection status without requiring a page UUID.
 *
 * Use this for UI components (TopBar, OfflineBanner) that need to show
 * connection health regardless of whether a page is currently open.
 */

import { useEffect, useState } from 'react';
import { liveSyncManager } from '../LiveSyncManager';

export type LiveSyncStatus = 'connected' | 'disconnected' | 'connecting' | 'error' | 'idle';

export function useLiveSyncStatus(): LiveSyncStatus {
  const [status, setStatus] = useState<LiveSyncStatus>('idle');

  useEffect(() => {
    const unsub = liveSyncManager.onStatusChange((s) => {
      setStatus(s);
    });
    return unsub;
  }, []);

  return status;
}
