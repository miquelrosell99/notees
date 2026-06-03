/**
 * LiveSyncIndicator — Minimal dot indicator next to the app title.
 *
 * Shows a colored dot indicating the WebSocket live-sync state:
 * - Green pulse = connected and syncing
 * - Yellow = connecting / reconnecting
 * - Red hollow circle = error / disconnected
 * - Hidden = no page active (idle)
 */

import { useEffect, useState } from 'react';
import { liveSyncManager } from '@/collab/LiveSyncManager';
import './LiveSyncIndicator.css';

export function LiveSyncIndicator() {
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'connecting' | 'error' | 'idle'>('idle');

  useEffect(() => {
    const unsub = liveSyncManager.onStatusChange((s) => {
      setStatus(s);
    });
    return unsub;
  }, []);

  if (status === 'idle') return null;

  const label =
    status === 'connected'
      ? 'Live sync active'
      : status === 'connecting'
        ? 'Connecting…'
        : status === 'error'
          ? 'Sync error'
          : 'Offline';

  return (
    <span
      className={`live-sync-indicator live-sync-indicator--${status}`}
      title={label}
      aria-label={label}
      role="status"
    />
  );
}
