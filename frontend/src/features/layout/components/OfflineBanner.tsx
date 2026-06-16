/**
 * OfflineBanner — banner showing offline status.
 *
 * Appears at the top of the viewport with a warning color when the browser
 * is offline.
 */
import React from 'react';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { Icon } from '@/components/ui/Icon';
import './OfflineBanner.css';

export function OfflineBanner(): React.ReactNode {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="offline-banner offline-banner--offline" role="status" aria-live="polite">
      <Icon path="mdi mdi-wifi-off" className="offline-banner__icon" />
      <span className="offline-banner__text">Working offline — changes will sync when you reconnect</span>
    </div>
  );
}
