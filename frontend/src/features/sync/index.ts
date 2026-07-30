/**
 * Sync feature barrel.
 *
 * Public exports for the local-first sync layer.
 */

export { useUIStateStore, type NodeUIState } from './stores/uiStateStore';
export { useSyncStatusStore, DEFAULT_PROGRESS, type SyncStatus } from './stores/syncStatusStore';
export { useConflictStore, type SyncConflict, type ConflictType } from './stores/conflictStore';
export { useFoldKeyboardShortcut } from './hooks/useFoldKeyboardShortcut';
export { SyncStatusIndicator } from './components/SyncStatusIndicator';
export { ConflictResolutionModal } from './components/ConflictResolutionModal';
export { SyncConflictListener } from './components/SyncConflictListener';
