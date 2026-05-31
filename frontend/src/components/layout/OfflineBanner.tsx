/**
 * OfflineBanner — banner showing offline status and pending mutation count.
 *
 * Appears at the top of the viewport with a warning color. Shows the number
 * of queued changes when offline, and sync status when reconnecting.
 */
import React from 'react';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import './OfflineBanner.css';

export function OfflineBanner(): React.ReactNode {
  const isOnline = useOnlineStatus();
  const { pendingCount, isDraining } = useOfflineQueue();

  if (isOnline && pendingCount === 0) return null;

  let text: string;
  let icon: string;

  if (!isOnline) {
    if (pendingCount > 0) {
      text = `Working offline — ${pendingCount} change${pendingCount === 1 ? '' : 's'} queued`;
    } else {
      text = 'Working offline — changes will sync when you reconnect';
    }
    icon = 'mdi mdi-wifi-off';
  } else if (isDraining) {
    text = `Syncing ${pendingCount} change${pendingCount === 1 ? '' : 's'}...`;
    icon = 'mdi mdi-sync';
  } else {
    text = 'All changes synced';
    icon = 'mdi mdi-wifi';
  }

  return (
    <div className="offline-banner" role="status" aria-live="polite">
      <span className={`offline-banner__icon mdi ${icon}`} />
      <span className="offline-banner__text">{text}</span>
    </div>
  );
}
