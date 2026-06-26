/**
 * SyncStatusIndicator — toolbar widget showing the v2 sync state.
 *
 * Displays a compact icon + label for synced / syncing / offline / error.
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
  const { status, pendingCount, failedCount, lastError, queue } = useSyncStatusStore();
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
        <span className="sync-status-indicator__label" style={{ color: config.color }}>
          {config.label}
        </span>
      </Button>

      {open && (
        <div
          className="sync-status-indicator__popover"
          role="dialog"
          aria-label="Sync queue"
        >
          <div className="sync-status-indicator__popover-header">
            <strong>{config.label}</strong>
            {pendingCount > 0 && <span>{pendingCount} pending</span>}
            {failedCount > 0 && <span className="sync-status-indicator__failed">{failedCount} failed</span>}
          </div>
          {queue.length === 0 ? (
            <p className="sync-status-indicator__empty">All changes are saved.</p>
          ) : (
            <ul className="sync-status-indicator__queue">
              {queue.slice(0, 20).map((entry) => (
                <li key={entry.op.id} className="sync-status-indicator__queue-item">
                  <span className="sync-status-indicator__queue-type">{entry.op.type}</span>
                  <span className="sync-status-indicator__queue-meta">
                    {entry.attemptCount > 0
                      ? `${entry.attemptCount} retries`
                      : 'pending'}
                  </span>
                  {entry.lastError && (
                    <span className="sync-status-indicator__queue-error" title={entry.lastError}>
                      {entry.lastError}
                    </span>
                  )}
                </li>
              ))}
            </ul>
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
