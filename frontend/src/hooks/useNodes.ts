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
  activityKeys 
} from './queryKeys';

// ==================== Node Queries ====================
export {
  useNodes,
  useNode,
  useNodeMetadata,
  useNodeChildren,
  useNodeByUuid,
  usePageContent,
  usePage,
  useGraphData,
  useBacklinks,
  useLinkedReferences,
  usePropertyBacklinks,
  useExistingDailyPages,
  useDailyNote,
  useTodayNote,
  useMonthlyNote,
  useYearlyNote,
  useTodayPage,
  usePages,
  useSearch,
  useTags,
  useTypes,
  useSearchTypes,
  useNodesByTag,
  useTasks,
  useArchivedPages,
  useNodesWithType,
  useTextLinks,
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
  useAddType,
  useRemoveType,
  useAddTagLink,
  useRemoveTagLink,
} from './useNodeMutations';

// ==================== Property Hooks ====================
export {
  useProperties,
  useProperty,
  useCreateProperty,
  useUpdateProperty,
  useTypeProperties,
  useTypeExtends,
  useAddPropertyToType,
  useRemovePropertyFromType,
  useAddTypeExtends,
  useRemoveTypeExtends,
  useSetNodeProperty,
  useNodesWithProperty,
} from './useProperties';

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
  useResetLinkClick,
} from './useActivity';
