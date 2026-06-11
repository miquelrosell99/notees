/**
 * useLivePageSync — React hook that wires a page into the lightweight
 * live-sync WebSocket.  It automatically connects when the nodeUuid
 * becomes available and disconnects on unmount or page change.
 *
 * Responsibilities:
 * - Drive LiveSyncManager connect/disconnect lifecycle
 * - Apply remote block updates to TanStack Query cache (skipping the
 *   block the local user is currently editing to avoid cursor jumps)
 * - Forward presence events into livePresenceStore
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { liveSyncManager } from '@/collab/LiveSyncManager';
import { useLivePresenceStore, type PresenceUser } from '@/stores/livePresenceStore';
import type { Node } from '@/types';
import { updateNodeInTreeCaches, updateNodeInFlatCaches, updateNodeInListCaches } from '@/hooks/cacheUtils';

interface UseLivePageSyncOptions {
  /** Page UUID to sync.  If null/empty the hook is a no-op. */
  nodeUuid: string | null | undefined;
  /** Server node ID of the page (for cache invalidation). */
  pageId?: number | null;
}

/**
 * Apply a remote block update to all relevant TanStack Query caches.
 * This mirrors the optimistic update logic in useUpdateNode but is
 * triggered by a WebSocket message rather than a local mutation.
 */
function applyRemoteBlockUpdate(
  queryClient: ReturnType<typeof useQueryClient>,
  blockId: number,
  name: string,
) {
  const updater = (node: Node): Node => ({ ...node, name });

  updateNodeInTreeCaches(queryClient, blockId, updater);
  updateNodeInFlatCaches(queryClient, blockId, updater);
  updateNodeInListCaches(queryClient, blockId, updater);
}

export function useLivePageSync({ nodeUuid }: UseLivePageSyncOptions) {
  const queryClient = useQueryClient();
  const unsubRef = useRef<(() => void) | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting' | 'error' | 'idle'>('idle');

  useEffect(() => {
    if (!nodeUuid) return;

    const unsubStatus = liveSyncManager.onStatusChange(setConnectionStatus);

    try {
      liveSyncManager.connect(nodeUuid);
    } catch (err) {
      console.warn('[useLivePageSync] Failed to connect live sync, retrying...', err);
    }

    const presence = useLivePresenceStore.getState();

    const unsub = liveSyncManager.onMessage((msg) => {
      try {
        switch (msg.type) {
          case 'user_focus': {
            presence.setUserFocus(nodeUuid, msg.block_uuid, msg.user);
            break;
          }
          case 'user_blur': {
            presence.removeUserFocus(nodeUuid, msg.block_uuid, msg.user_id);
            break;
          }
          case 'block_locked': {
            const user: PresenceUser = {
              id: msg.user_id,
              name: 'User',
              color: '',
            };
            const usersOnBlock = presence.getUsersOnBlock(nodeUuid, msg.block_uuid);
            const existing = usersOnBlock.find((u) => u.id === msg.user_id);
            if (existing) {
              user.name = existing.name;
              user.color = existing.color;
            }
            presence.setLockOwner(nodeUuid, msg.block_uuid, user);
            break;
          }
          case 'block_lock_denied': {
            break;
          }
          case 'block_lock_released':
          case 'lock_expired': {
            presence.removeLockOwner(nodeUuid, msg.block_uuid);
            presence.removeUserFocus(nodeUuid, msg.block_uuid, msg.user_id);
            break;
          }
          case 'users_list': {
            for (const u of msg.users) {
              const { block_uuid, ...user } = u;
              presence.setUserFocus(nodeUuid, block_uuid, user);
            }
            break;
          }
          case 'block_updated': {
            const localFocus = presence.getLocalFocus(nodeUuid);
            if (localFocus === msg.block_uuid) {
              return;
            }
            applyRemoteBlockUpdate(
              queryClient,
              msg.block_id,
              msg.name,
            );
            const typingUser: PresenceUser = {
              id: msg.user_id,
              name: 'User',
              color: '',
            };
            const usersOnBlock = presence.getUsersOnBlock(nodeUuid, msg.block_uuid);
            const existing = usersOnBlock.find((u) => u.id === msg.user_id);
            if (existing) {
              typingUser.name = existing.name;
              typingUser.color = existing.color;
            }
            presence.setUserTyping(nodeUuid, msg.block_uuid, typingUser, 3000);
            break;
          }
        }
      } catch (err) {
        console.warn('[useLivePageSync] Error handling live-sync message:', err);
      }
    });

    unsubRef.current = unsub;

    return () => {
      unsub();
      unsubStatus();
      liveSyncManager.disconnect();
      unsubRef.current = null;
      if (nodeUuid) {
        useLivePresenceStore.setState((state) => ({
          presence: { ...state.presence, [nodeUuid]: {} },
          locks: { ...state.locks, [nodeUuid]: {} },
          typing: { ...state.typing, [nodeUuid]: {} },
          localFocus: { ...state.localFocus, [nodeUuid]: null },
        }));
      }
    };
  }, [nodeUuid, queryClient]);

  return connectionStatus;
}
