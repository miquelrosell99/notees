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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { liveSyncManager, useLivePresenceStore, type PresenceUser } from '@/features/collab';
import { useAuthStore } from '@/features/auth';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { useWorkspaces } from '@/features/workspace';
import { useSyncProtocolVersion } from '@/features/workspace/hooks/useSyncProtocolVersion';
import type { Node } from '@/types';
import { updateNodeInTreeCaches, updateNodeInFlatCaches, updateNodeInListCaches } from '@/hooks/cacheUtils';

interface UseLivePageSyncOptions {
  /** Page UUID to sync.  If null/empty the hook is a no-op. */
  nodeUuid: string | null | undefined;
  /** Server node ID of the page (for cache invalidation). */
  pageId?: string | null;
  /** When false, the hook is a no-op and always reports 'idle'. */
  enabled?: boolean;
}

/**
 * Apply a remote block update to all relevant TanStack Query caches.
 * This mirrors the optimistic update logic in useUpdateNode but is
 * triggered by a WebSocket message rather than a local mutation.
 */
function applyRemoteBlockUpdate(
  queryClient: ReturnType<typeof useQueryClient>,
  blockId: string,
  name: string,
) {
  const updater = (node: Node): Node => ({ ...node, name });

  updateNodeInTreeCaches(queryClient, blockId, updater);
  updateNodeInFlatCaches(queryClient, blockId, updater);
  updateNodeInListCaches(queryClient, blockId, updater);
}

export function useLivePageSync({ nodeUuid, enabled = true }: UseLivePageSyncOptions) {
  const queryClient = useQueryClient();
  const unsubRef = useRef<(() => void) | null>(null);
  const authVerified = useAuthStore((s) => s.authVerified);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting' | 'error' | 'idle'>('idle');

  const { data: workspacesData } = useWorkspaces({ enabled: authVerified });
  const activeWorkspace = useMemo(() => {
    if (!workspacesData?.items) return null;
    return workspacesData.items.find((ws) => ws.is_active) ?? workspacesData.items[0] ?? null;
  }, [workspacesData]);
  const { data: protocolData } = useSyncProtocolVersion(activeWorkspace?.uuid);
  const protocolVersion = (protocolData?.sync_protocol_version as 'v1' | 'v2') ?? 'v1';

  useEffect(() => {
    if (!enabled || !nodeUuid || !authVerified) return;

    const unsubStatus = liveSyncManager.onStatusChange(setConnectionStatus);

    try {
      liveSyncManager.connect(
        nodeUuid,
        activeWorkspace?.uuid ?? null,
        protocolVersion,
      );
    } catch (err) {
      console.warn('[useLivePageSync] Failed to connect live sync, retrying...', err);
    }

    const presence = useLivePresenceStore.getState();

    const notifications = useNotificationStore.getState();

    const unsub = liveSyncManager.onMessage((msg) => {
      try {
        switch (msg.type) {
          case 'user_focus': {
            presence.setUserFocus(nodeUuid, msg.block_uuid, msg.user);
            break;
          }
          case 'user_blur': {
            presence.removeUserFocus(nodeUuid, msg.block_uuid, msg.user_id);
            presence.clearUserTyping(nodeUuid, msg.block_uuid, msg.user_id);
            break;
          }
          case 'user_typing': {
            presence.setUserTyping(nodeUuid, msg.block_uuid, msg.user, 3000);
            break;
          }
          case 'block_locked': {
            const user: PresenceUser = {
              nodeUuid: msg.user_id,
              name: 'User',
              color: '',
            };
            const usersOnBlock = presence.getUsersOnBlock(nodeUuid, msg.block_uuid);
            const existing = usersOnBlock.find((u) => u.nodeUuid === msg.user_id);
            if (existing) {
              user.name = existing.name;
              user.color = existing.color;
            }
            presence.setLockOwner(nodeUuid, msg.block_uuid, user);
            // If the local user was queued, they now hold the lock.
            presence.setQueued(nodeUuid, msg.block_uuid, false);
            presence.setConflict(nodeUuid, msg.block_uuid, null);
            break;
          }
          case 'lock_granted': {
            presence.setQueued(nodeUuid, msg.block_uuid, false);
            presence.setConflict(nodeUuid, msg.block_uuid, null);
            useEditorFocusStore.getState().setPendingFocus(msg.block_uuid);
            notifications.success('Lock available', 'You can now edit this block.');
            break;
          }
          case 'block_lock_denied': {
            if (msg.reason === 'already_locked' && msg.locked_by) {
              presence.setLockOwner(nodeUuid, msg.block_uuid, msg.locked_by);
              if (msg.queued) {
                presence.setQueued(nodeUuid, msg.block_uuid, true);
                notifications.info(
                  'Block locked',
                  `${msg.locked_by.name} is editing this block. You will be notified when it is available.`,
                );
              }
            } else if (msg.reason === 'lock_lost') {
              presence.setConflict(nodeUuid, msg.block_uuid, { reason: 'lock_lost' });
              notifications.warning(
                'Edit conflict',
                'Your changes could not be saved because the lock was released. Please refresh the block.',
              );
            }
            break;
          }
          case 'block_lock_released':
          case 'lock_expired': {
            presence.removeLockOwner(nodeUuid, msg.block_uuid);
            presence.removeUserFocus(nodeUuid, msg.block_uuid, msg.user_id);
            presence.clearUserTyping(nodeUuid, msg.block_uuid, msg.user_id);
            if (msg.type === 'lock_expired') {
              const localFocus = presence.getLocalFocus(nodeUuid);
              if (localFocus === msg.block_uuid) {
                presence.setConflict(nodeUuid, msg.block_uuid, { reason: 'lock_expired' });
                notifications.warning(
                  'Lock expired',
                  'Your lock on this block expired due to inactivity. Click to resume editing.',
                );
              }
            }
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
              nodeUuid: msg.user_id,
              name: 'User',
              color: '',
            };
            const usersOnBlock = presence.getUsersOnBlock(nodeUuid, msg.block_uuid);
            const existing = usersOnBlock.find((u) => u.nodeUuid === msg.user_id);
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
          queues: { ...state.queues, [nodeUuid]: {} },
          conflicts: { ...state.conflicts, [nodeUuid]: {} },
          localFocus: { ...state.localFocus, [nodeUuid]: null },
        }));
      }
    };
  }, [nodeUuid, queryClient, enabled, authVerified, activeWorkspace?.uuid, protocolVersion]);

  return connectionStatus;
}
