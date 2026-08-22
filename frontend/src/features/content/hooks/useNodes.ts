/**
 * React Query hooks for nodes API
 * 
 * This module re-exports all node-related hooks from their modular files.
 * For better code organization, the hooks are split into:
 * - queryKeys.ts - Query key factories
 * - useNodeQueries.ts - Read-only node queries
 * - useNodeMutations.ts - Node create/update/delete mutations
 * - useProperties.ts - Property queries and mutations
 * - useComments.ts - Comment queries and mutations
 * - useActivity.ts - Activity tracking hooks
 * 
 * Uses the node-centric architecture where everything is a node.
 */

// ==================== Query Keys ====================
export { 
  nodeKeys, 
  propertyKeys, 
  commentKeys, 
  activityKeys,
  settingsKeys,
} from '@/hooks/queryKeys';

// ==================== Node Queries ====================
export {
  useNodes,
  useNode,
  useNodeChildren,
  useNodeByUuid,
  useGraphData,
  useGraphNodes,
  useGraphLinks,
  useBacklinks,
  useLinkedReferences,
  usePropertyBacklinks,
  useUnlinkedMentions,
  usePromoteMention,
  useIgnoreMention,
  useUnignoreMention,
  useExistingDailyPages,
  useDailyNote,
  useTodayNote,
  useMonthlyNote,
  useYearlyNote,
  usePages,
  useSearch,
  useTags,
  useClasses,
  useSearchClasses,
  useNodesByTag,
  useTasks,
  useNodesWithClass,
  useTextLinks,
  useSuggestions,
} from './useNodeQueries';

// ==================== Node Mutations ====================
export {
  useCreateNode,
  useUpdateNode,
  useDeleteNode,
  useArchiveNode,
  useUnarchiveNode,
  useMoveNode,
  useAddTag,
  useRemoveTag,
  useAddClass,
  useRemoveClass,
  useAddTagLink,
  useRemoveTagLink,
  useAddAlias,
  useRemoveAlias,
} from './useNodeMutations';



// ==================== Comment Hooks ====================
export {
  useComments,
  useCommentCount,
  useCreateComment,
  useDeleteComment,
} from './useComments';

// ==================== Activity Hooks ====================
export {
  useNodeActivity,
  useCreateNodeActivity,
  useDeleteNodeActivity,
  useLinkClicks,
  useLinkClick,
  useTrackLinkClick,
} from './useActivity';

// ==================== Helper Hooks ====================
// Helper hooks live in ./usePageClass and are exported from the feature barrel.
