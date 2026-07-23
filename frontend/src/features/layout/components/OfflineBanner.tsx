/**
 * OfflineBanner — banner showing offline or backend-unhealthy status.
 *
 * Appears at the top of the viewport when the browser is offline or when the
 * backend is unreachable while the browser still believes it is online.
 */
import React from 'react';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useConnectionStore } from '@/stores/connectionStore';
import { Icon } from '@/components/ui';
import './OfflineBanner.css';

export function OfflineBanner(): React.ReactNode {
  const isOnline = useOnlineStatus();
  const backendHealthy = useConnectionStore((state) => state.healthy);

  if (isOnline && backendHealthy !== false) {
    return null;
  }

  const isBackendWarning = isOnline && backendHealthy === false;

  return (
    <div
      className={`offline-banner ${isBackendWarning ? 'offline-banner--warning' : 'offline-banner--offline'}`}
      role="status"
      aria-live="polite"
    >
      <Icon
        path={isBackendWarning ? 'mdi mdi-server-network-off' : 'mdi mdi-wifi-off'}
        className="offline-banner__icon"
      />
      <span className="offline-banner__text">
        {isBackendWarning
          ? 'Backend unreachable — changes will sync when it recovers'
          : 'Working offline — changes will sync when you reconnect'}
      </span>
    </div>
  );
}
