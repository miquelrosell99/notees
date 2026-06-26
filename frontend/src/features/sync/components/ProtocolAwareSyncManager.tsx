/**
 * ProtocolAwareSyncManager — mounts the correct sync adapter for the active workspace.
 *
 * - v1: legacy per-operation REST SyncManager (frontend/src/sync/SyncManager.tsx)
 * - v2: batch vector-clock SyncManager (features/sync/SyncManagerV2.tsx)
 *
 * Until the active workspace is known, no sync adapter runs.
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useWorkspaces } from '@/features/workspace';
import { SyncManager } from '@/sync';
import { SyncManagerV2 } from '../SyncManagerV2';

function generateClientId(): string {
  let id = localStorage.getItem('notees-client-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('notees-client-id', id);
  }
  return id;
}

export function ProtocolAwareSyncManager(): ReactNode {
  const { data: workspacesData, isLoading } = useWorkspaces({ enabled: true });

  const activeWorkspace = useMemo(() => {
    if (!workspacesData?.items) return null;
    return workspacesData.items.find((ws) => ws.is_active) ?? workspacesData.items[0] ?? null;
  }, [workspacesData]);

  if (isLoading || !activeWorkspace) {
    return null;
  }

  if (activeWorkspace.sync_protocol_version === 'v2') {
    return <SyncManagerV2 workspaceUuid={activeWorkspace.uuid} clientId={generateClientId()} />;
  }

  return <SyncManager />;
}
