/**
 * Hooks module - exports generic UI/utility hooks.
 *
 * Feature-specific hooks are re-exported here for backward compatibility;
 * prefer importing directly from their feature directories.
 */

// Generic hooks (source of truth remains in src/hooks)
export * from './useBatchedNode';
export * from './useVirtualizedQuery';
export * from './useKeyboardListNav';
export * from './useViewportFlip';
export { useCommand } from './useCommand';
export { useKeyboardShortcut } from './useKeyboardShortcut';
export { useGlobalKeyboardListener } from './useGlobalKeyboardListener';
export { KeyboardShortcutsProvider } from './KeyboardShortcutsProvider';
export * from './useFocusTrap';
export * from './useClickOutside';
export * from './useEscapeKey';
export * from './useModal';
export * from './useIsMobile';
export * from './useInView';
export * from './useCanvasViewport';
export * from './useEffectiveNodePermissions';
export * from './useDocumentTitle';
export * from './useReducedMotion';
export * from './useOnlineStatus';
export * from './useDelayedOverlay';
export * from './useCopiedState';
export * from './useDebouncedValue';
export * from './useNotifications';
export * from './useTemplates';
export * from './useWindowFocusActiveBlock';
export * from './useLiveSyncStatus';
export * from './useCommandPaletteSearch';
export * from './contentSaveTracker';
export * from './keyboardShortcutHelpers';
export * from './cacheUtils';
export * from './queryKeys';

// Feature-specific hooks (re-exported for backward compatibility)
export * from '@/features/content/hooks/useNodes';
export * from '@/features/content/hooks/useNodeViews';
export { useCurrentNodeUuid } from '@/features/content/hooks/useCurrentNodeUuid';
export * from '@/features/content/hooks/useNodeSearch';
export * from '@/features/layout/hooks/useQuickAdd';
export * from '@/features/content/hooks/useContentSave';
export * from '@/features/content/hooks/useNodeDisplay';
export * from '@/features/content/hooks/useLinkedReferencesCount';
export * from '@/features/content/hooks/useProperties';
export * from '@/features/content/hooks/useHierarchicalPath';
export * from '@/features/content/hooks/useResolvedClassDetails';
export * from '@/features/content/hooks/useNodeNavigation';
export * from '@/features/layout/hooks/useNoteesUri';
export * from '@/features/workspace/hooks/useSettings';
export { useLogseqImporter, countBlocks, buildAstFromLogseqText } from '@/features/workspace/hooks/useLogseqImporter';
export type { ImportMode, LogseqImportReport } from '@/features/workspace/hooks/useLogseqImporter';
export * from '@/features/content/hooks/useComments';
export * from '@/features/layout/hooks/useAndroidBridge';
export * from '@/features/queries/hooks/useStringifyAST';
export * from '@/features/content/hooks/useListDragSort';
export * from '@/features/content/hooks/useLivePageSync';
export * from '@/features/workspace/hooks/useWorkspaceRole';
export * from '@/features/content/hooks/useFavorites';
export * from '@/features/content/hooks/useRecents';
export * from '@/features/tasks/hooks/useTaskRecurrence';
export * from '@/features/shares/hooks/useShares';
