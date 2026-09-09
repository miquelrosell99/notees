/**
 * useLivePageSync — React hook that wires a page into workspace presence over
 * the relay WebSocket (the same channel that carries realtime ops).
 *
 * Responsibilities:
 * - Subscribe to presence frames from the workspace's SyncEngine
 * - Forward presence events into livePresenceStore
 * - Expose the realtime connection status for the page header
 *
 * Presence is ephemeral: frames are never persisted and never affect the
 * sync seq cursor.
 */

import { useEffect, useState } from 'react';
import { useLivePresenceStore, type PresenceUser } from '@/features/collab';
import { useAuthStore } from '@/features/auth';
import { useCapabilities } from '@/config/capabilities';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { getWorkspaceSyncEngine } from '@/core/adapters/workspaceStoreAdapter';
import type { RelayPresenceUser, RelayWsStatus } from '@/core/relayWs';

interface UseLivePageSyncOptions {
  /** Page UUID to sync.  If null/empty the hook is a no-op. */
  nodeUuid: string | null | undefined;
  /** Server node ID of the page (unused; kept for caller compatibility). */
  pageId?: string | null;
  /** When false, the hook is a no-op and always reports 'idle'. */
  enabled?: boolean;
}

export type LivePageSyncStatus = RelayWsStatus | 'idle';

function toPresenceUser(user: RelayPresenceUser): PresenceUser {
  return { nodeUuid: user.id, name: user.name, color: user.color };
}

export function useLivePageSync({ nodeUuid, enabled = true }: UseLivePageSyncOptions) {
  const authVerified = useAuthStore((s) => s.authVerified);
  // Presence rides the relay WebSocket, which is server-only; local mode and
  // follower tabs have no realtime channel and stay 'idle'.
  const capabilities = useCapabilities();
  const workspaceUuid = useCurrentWorkspaceUuid();
  const [connectionStatus, setConnectionStatus] = useState<LivePageSyncStatus>('idle');

  useEffect(() => {
    if (!enabled || !nodeUuid || !authVerified || !capabilities.collabPresence || !workspaceUuid) {
      return;
    }
    const engine = getWorkspaceSyncEngine(workspaceUuid);
    if (!engine) return;

    const unsubStatus = engine.subscribeRealtimeStatus(setConnectionStatus);

    const presence = useLivePresenceStore.getState();

    const unsub = engine.subscribePresence((frame) => {
      try {
        switch (frame.action) {
          case 'user_focus': {
            presence.setUserFocus(nodeUuid, frame.blockUuid, toPresenceUser(frame.user));
            break;
          }
          case 'user_blur': {
            presence.removeUserFocus(nodeUuid, frame.blockUuid, frame.user.id);
            presence.clearUserTyping(nodeUuid, frame.blockUuid, frame.user.id);
            break;
          }
          case 'user_typing': {
            presence.setUserTyping(nodeUuid, frame.blockUuid, toPresenceUser(frame.user), 3000);
            break;
          }
          case 'users_list': {
            for (const u of frame.users) {
              presence.setUserFocus(nodeUuid, u.blockUuid, toPresenceUser(u.user));
            }
            break;
          }
        }
      } catch (err) {
        console.warn('[useLivePageSync] Error handling presence frame:', err);
      }
    });

    return () => {
      unsub();
      unsubStatus();
      if (nodeUuid) {
        useLivePresenceStore.setState((state) => ({
          presence: { ...state.presence, [nodeUuid]: {} },
          locks: { ...state.locks, [nodeUuid]: {} },
          typing: { ...state.typing, [nodeUuid]: {} },
          queues: { ...state.queues, [nodeUuid]: {} },
          conflicts: { ...state.conflicts, [nodeUuid]: {} },
          localFocus: { ...state.localFocus, [nodeUuid]: null },
        }));
      }
    };
  }, [nodeUuid, enabled, authVerified, workspaceUuid, capabilities.collabPresence]);

  return connectionStatus;
}
