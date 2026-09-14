/**
 * SyncStatusIndicator — toolbar widget showing the v2 sync state.
 *
 * Non-interactive status icon for synced / syncing / offline / error,
 * plus a text Retry button while in the error state.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useSyncStatusStore, type SyncStatus } from '../stores/syncStatusStore';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { getWorkspaceSyncEngine } from '@/core/adapters/workspaceStoreAdapter';
import { Icon } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
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
  const workspaceUuid = useCurrentWorkspaceUuid();
  const [retrying, setRetrying] = useState(false);
  const config = STATUS_CONFIG[status];

  const handleRetry = async (): Promise<void> => {
    const engine = workspaceUuid ? getWorkspaceSyncEngine(workspaceUuid) : undefined;
    if (!engine) return;
    setRetrying(true);
    try {
      // retryQuarantined requeues quarantined ops (a no-op when there are
      // none) and always ends with a syncOnce, so it covers transient
      // pull/push failures too.
      await engine.retryQuarantined();
    } finally {
      setRetrying(false);
    }
  };

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
      {status === 'error' && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleRetry()}
          disabled={retrying}
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      )}
    </span>
  );
}
