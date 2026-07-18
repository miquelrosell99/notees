/**
 * SyncStatusIndicator — toolbar widget showing the v2 sync state.
 *
 * Displays a compact icon for synced / syncing / offline / error.
 * Clicking opens a popover with the pending/failed operation queue.
 */

import { useState, useRef } from 'react';
import type { ReactNode } from 'react';
import { useSyncStatusStore, type SyncStatus } from '../stores/syncStatusStore';
import { Icon } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';

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
  const { status, pendingCount, failedCount, lastError } = useSyncStatusStore();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const config = STATUS_CONFIG[status];

  return (
    <div className="sync-status-indicator">
      <Button
        ref={buttonRef}
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title={lastError ?? config.label}
        aria-label={config.label}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon
          path={config.icon}
          size="sm"
          color={config.color}
          className={config.spin ? 'sync-status-indicator__icon--spin' : ''}
        />
      </Button>

      {open && (
        <div
          className="sync-status-indicator__popover"
          role="dialog"
          aria-label="Sync status"
        >
          <div className="sync-status-indicator__popover-header">
            <strong>{config.label}</strong>
            {pendingCount > 0 && <span>{pendingCount} pending</span>}
            {failedCount > 0 && <span className="sync-status-indicator__failed">{failedCount} failed</span>}
          </div>
          {pendingCount === 0 && failedCount === 0 ? (
            <p className="sync-status-indicator__empty">All changes are saved.</p>
          ) : (
            <p className="sync-status-indicator__summary">
              {pendingCount > 0 && `${pendingCount} change${pendingCount === 1 ? '' : 's'} pending`}
              {pendingCount > 0 && failedCount > 0 && ' · '}
              {failedCount > 0 && `${failedCount} failed`}
            </p>
          )}
          {lastError && (
            <p className="sync-status-indicator__last-error" title={lastError}>
              {lastError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
