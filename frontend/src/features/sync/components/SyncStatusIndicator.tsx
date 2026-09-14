/**
 * SyncStatusIndicator — toolbar widget showing the v2 sync state.
 *
 * Non-interactive status icon for synced / syncing / offline / error.
 */

import type { ReactNode } from 'react';
import { useSyncStatusStore, type SyncStatus } from '../stores/syncStatusStore';
import { Icon } from '@/components/ui/icons';
import './SyncStatusIndicator.css';

const STATUS_CONFIG: Record<
  SyncStatus,
  { label: string; icon: string; color: string; spin?: boolean }
> = {
  synced: { label: 'Saved', icon: 'mdi-check-circle-outline', color: 'var(--color-success)' },
  syncing: { label: 'Syncing…', icon: 'mdi-sync', color: 'var(--color-info)', spin: true },
  offline: { label: 'Offline', icon: 'mdi-cloud-off-outline', color: 'var(--color-warning)' },
  error: { label: 'Sync error', icon: 'mdi-alert-circle-outline', color: 'var(--color-danger)' },
};

export function SyncStatusIndicator(): ReactNode {
  const { status, lastError } = useSyncStatusStore();
  const config = STATUS_CONFIG[status];

  return (
    <span
      className="sync-status-indicator"
      role="status"
      title={lastError ?? config.label}
      aria-label={lastError ?? config.label}
    >
      <Icon
        path={config.icon}
        size="sm"
        color={config.color}
        className={config.spin ? 'sync-status-indicator__icon--spin' : ''}
      />
    </span>
  );
}
