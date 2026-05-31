/**
 * OfflineBanner — subtle banner shown when the app detects it's offline.
 *
 * Appears at the top of the viewport with a warning color. Disappears
 * automatically when connectivity is restored.
 */
import React from 'react';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import './OfflineBanner.css';

export function OfflineBanner(): React.ReactNode {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="offline-banner" role="status" aria-live="polite">
      <span className="offline-banner__icon mdi mdi-wifi-off" />
      <span className="offline-banner__text">
        Working offline — changes will sync when you reconnect
      </span>
    </div>
  );
}
