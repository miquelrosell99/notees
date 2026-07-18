import { UndoManager } from '../undo';
import { useWorkspaceStore } from './useWorkspaceStore';

/**
 * Return the UndoManager for the current workspace, creating it on demand if
 * the WorkspaceStore already exists. Operations that go through the manager
 * are recorded for undo/redo.
 */
export function useUndoManager(workspaceId: string): UndoManager | undefined {
  const { store } = useWorkspaceStore(workspaceId);
  if (!store) return undefined;
  return UndoManager.getOrCreateUndoManager(workspaceId, store);
}
