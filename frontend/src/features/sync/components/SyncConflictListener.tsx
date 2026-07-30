import { useEffect } from 'react';
import { getWorkspaceSyncEngine } from '@/core/adapters/workspaceStoreAdapter';
import type { SyncConflictInput } from '@/core/syncConflicts';
import { useConflictStore, type ConflictType, type SyncConflict } from '../stores/conflictStore';

const CONFLICT_TYPE_MAP: Record<SyncConflictInput['conflictType'], ConflictType> = {
  move_move: 'tree_conflict',
  node_deleted: 'node_deleted',
  class_conflict: 'class_conflict',
  property_conflict: 'property_conflict',
};

interface SyncConflictListenerProps {
  workspaceId: string;
}

/**
 * Listens to semantic conflicts emitted by the sync engine and stores them in
 * the global conflict store so the UI can surface them for resolution.
 *
 * This component does not render anything. It should be mounted once per open
 * workspace, inside the workspace's provider tree.
 */
export function SyncConflictListener({ workspaceId }: SyncConflictListenerProps): null {
  useEffect(() => {
    const syncEngine = getWorkspaceSyncEngine(workspaceId);
    if (!syncEngine) return;

    const addConflict = useConflictStore.getState().addConflict;

    const unsubscribe = syncEngine.subscribeConflicts((inputs) => {
      for (const input of inputs) {
        const conflict: SyncConflict = {
          workspaceUuid: workspaceId,
          nodeUuid: input.nodeUuid,
          conflictType: CONFLICT_TYPE_MAP[input.conflictType],
          baseNode: null,
          ourNode: null,
          theirNode: null,
          operationIds: input.localOperationIds,
          createdAt: Date.now(),
        };
        addConflict(conflict);
      }
    });

    return unsubscribe;
  }, [workspaceId]);

  return null;
}
