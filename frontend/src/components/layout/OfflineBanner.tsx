/**
 * OfflineBanner — banner showing offline status and pending mutation count.
 *
 * Appears at the top of the viewport with a warning color. Shows the number
 * of queued changes when offline, and sync status when reconnecting.
 */
import React from 'react';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useLiveSyncStatus } from '@/hooks/useLiveSyncStatus';
import { Icon } from '@/components/core/Icon';
import './OfflineBanner.css';

export function OfflineBanner(): React.ReactNode {
  const isOnline = useOnlineStatus();
  const { pendingCount, isDraining } = useOfflineQueue();
  const liveSyncStatus = useLiveSyncStatus();

  // Show banner when:
  // - Browser is offline
  // - REST mutations are pending / draining
  // - Browser is online but WS live sync is disconnected/error
  const wsDisconnected = isOnline && (liveSyncStatus === 'disconnected' || liveSyncStatus === 'error');

  if (isOnline && pendingCount === 0 && !wsDisconnected) return null;

  let text: string;
  let icon: string;
  let statusClass = '';

  if (!isOnline) {
    if (pendingCount > 0) {
      text = `Working offline — ${pendingCount} change${pendingCount === 1 ? '' : 's'} queued`;
    } else {
      text = 'Working offline — changes will sync when you reconnect';
    }
    icon = 'mdi mdi-wifi-off';
    statusClass = 'offline-banner--offline';
  } else if (wsDisconnected) {
    text = liveSyncStatus === 'error'
      ? 'Live sync error — edits may not appear for others'
      : 'Live sync disconnected — reconnecting…';
    icon = 'mdi mdi-sync-off';
    statusClass = 'offline-banner--warning';
  } else if (isDraining) {
    text = `Syncing ${pendingCount} change${pendingCount === 1 ? '' : 's'}...`;
    icon = 'mdi mdi-sync';
    statusClass = 'offline-banner--syncing';
  } else {
    text = 'All changes synced';
    icon = 'mdi mdi-wifi';
    statusClass = 'offline-banner--synced';
  }

  return (
    <div className={`offline-banner ${statusClass}`} role="status" aria-live="polite">
      <Icon path={icon} className="offline-banner__icon" />
      <span className="offline-banner__text">{text}</span>
    </div>
  );
}
