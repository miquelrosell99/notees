/**
 * LiveSyncIndicator — Offline-only indicator next to the app title.
 *
 * The indicator is hidden while live sync is idle, connecting, or connected.
 * It appears only when the WebSocket is disconnected or in an error state,
 * showing a crossed-cloud icon.
 */

import { useEffect, useState } from 'react';
import { liveSyncManager } from '@/features/collab';
import { Icon } from '@/components/ui/icons';
import './LiveSyncIndicator.css';

export function LiveSyncIndicator() {
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'connecting' | 'error' | 'idle' | 'unauthorized'>('idle');

  useEffect(() => {
    const unsub = liveSyncManager.onStatusChange((s) => {
      setStatus(s);
    });
    return unsub;
  }, []);

  if (status === 'idle' || status === 'connected' || status === 'connecting') {
    return null;
  }

  const label = status === 'error' ? 'Sync error' : 'Offline';

  return (
    <span
      className="live-sync-indicator live-sync-indicator--offline"
      title={label}
      aria-label={label}
      role="status"
    >
      <Icon path="mdi-cloud-off-outline" size="sm" color="var(--color-error)" />
    </span>
  );
}
