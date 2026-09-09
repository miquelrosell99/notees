/**
 * LiveSyncIndicator — Offline-only indicator next to the app title.
 *
 * The indicator is hidden while the realtime relay channel is idle,
 * connecting, or connected. It appears only when the relay WebSocket is
 * disconnected or in an error state, showing a crossed-cloud icon.
 */

import { useEffect, useState } from 'react';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { getWorkspaceSyncEngine, isWorkspaceTabFollower } from '@/core/adapters/workspaceStoreAdapter';
import { useCapabilities } from '@/config/capabilities';
import type { RelayWsStatus } from '@/core/relayWs';
import { Icon } from '@/components/ui/icons';
import './LiveSyncIndicator.css';

export function LiveSyncIndicator() {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const capabilities = useCapabilities();
  const [status, setStatus] = useState<RelayWsStatus | 'idle'>('idle');

  useEffect(() => {
    // No realtime channel runs in local mode, in follower tabs, or without a
    // workspace route — nothing to warn about in those cases.
    if (!workspaceUuid || !capabilities.collabPresence || isWorkspaceTabFollower(workspaceUuid)) {
      setStatus('idle');
      return;
    }
    const engine = getWorkspaceSyncEngine(workspaceUuid);
    if (!engine) {
      setStatus('idle');
      return;
    }
    return engine.subscribeRealtimeStatus(setStatus);
  }, [workspaceUuid, capabilities.collabPresence]);

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
