/**
 * Sync feature barrel.
 *
 * Public exports for the local-first sync layer.
 */

export { useUIStateStore, type NodeUIState } from './stores/uiStateStore';
export { useSyncStatusStore, type SyncStatus } from './stores/syncStatusStore';
export { useFoldKeyboardShortcut } from './hooks/useFoldKeyboardShortcut';
export { SyncManagerV2 } from './SyncManagerV2';
export { SyncStatusIndicator } from './components/SyncStatusIndicator';
export { ConflictResolutionModal } from './components/ConflictResolutionModal';
export * from './api/syncV2';
