/**
 * useUndoStackPersistence — previously persisted runtime undo/redo stacks to IndexedDB.
 *
 * The new core UndoManager stores inverse operations as in-memory callbacks, so
 * cross-session persistence has been disabled. This hook remains as a no-op
 * integration point; a future Phase can add serializable operation-level
 * inverse snapshots if needed.
 */

export function useUndoStackPersistence(): void {
  // No-op: core undo stacks are currently in-memory only.
}
