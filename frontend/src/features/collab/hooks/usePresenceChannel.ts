/**
 * usePresenceChannel — imperative sender for ephemeral presence frames
 * (focus/blur/typing) over the workspace's relay WebSocket.
 *
 * Resolves the workspace's SyncEngine from the route param and delegates to
 * its realtime channel; a safe no-op in local mode, follower tabs, or when
 * the socket is not currently open.
 */

import { useMemo } from 'react';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { getWorkspaceSyncEngine } from '@/core/adapters/workspaceStoreAdapter';
import type { RelayPresenceAction } from '@/core/relayWs';

export interface PresenceChannel {
  sendPresence(action: RelayPresenceAction, blockUuid: string): void;
}

export function usePresenceChannel(): PresenceChannel {
  const workspaceUuid = useCurrentWorkspaceUuid();
  return useMemo(
    () => ({
      sendPresence: (action, blockUuid) => {
        if (!workspaceUuid) return;
        getWorkspaceSyncEngine(workspaceUuid)?.sendPresence(action, blockUuid);
      },
    }),
    [workspaceUuid]
  );
}
