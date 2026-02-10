/**
 * useBlockCallbacksFactory Hook
 * 
 * Creates the standard BlockCallbacks object used by NodeView, NodeContent,
 * and SidebarNodeView. Consolidates the 8 identical callback implementations
 * that were copy-pasted across 3 components.
 * 
 * Usage:
 *   const blockCallbacks = useBlockCallbacksFactory({
 *     onOpenBacklinks: (blockId) => addSidebarCard(blockId, 'block'),
 *     onAssetUpload: (blockId, typesOrFile) => { ... }, // optional, NodeContent only
 *   });
 */
import { useMemo } from 'react';
import { useAddClass, useAddTag, useAddTagLink, useCreateNode, useSystemClasses } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { BlockCallbacks } from './BlockCallbacksContext';
import type { AssetCategory } from '@/api/assets';
import { parseDate } from '@/utils/dateParser';
import { getOrCreateDaily, getOrCreateMonthly, getOrCreateYearly } from '@/api/nodes';

interface BlockCallbacksFactoryOptions {
  /** Handler for opening backlinks — varies by context (sidebar vs page view) */
  onOpenBacklinks: (blockId: number) => void;
  /** Optional asset upload handler — only NodeContent provides this */
  onAssetUpload?: (blockId: number, assetTypesOrFile?: AssetCategory[] | File) => void;
}

/**
 * Creates a standard BlockCallbacks object with all the common callbacks.
 * Only `onOpenBacklinks` and optionally `onAssetUpload` need to be provided
 * since they vary between consumers.
 */
export function useBlockCallbacksFactory(options: BlockCallbacksFactoryOptions): BlockCallbacks {
  const addClass = useAddClass();
  const addTag = useAddTag();
  const addTagLink = useAddTagLink();
  const createNode = useCreateNode();
  const { systemClassIds } = useSystemClasses();
  const { openCommentsForNode } = useNodesStore();

  return useMemo<BlockCallbacks>(() => ({
    onAddClass: (blockId, classNodeId, _keepInline, _className) => {
      addClass.mutate({ nodeId: blockId, classId: classNodeId });
    },
    onAddTag: (blockId, tagNodeId, keepInline, _tagName) => {
      addTag.mutate({ nodeId: blockId, tagId: tagNodeId });
      if (keepInline) {
        addTagLink.mutate({ nodeId: blockId, targetNodeId: tagNodeId });
      }
    },
    onCreateClass: (blockId, name, _keepInline) => {
      if (!systemClassIds?.page || !systemClassIds?.class) return;
      createNode.mutate(
        { name, classes: [systemClassIds.page, systemClassIds.class] },
        { onSuccess: (newPage) => { addClass.mutate({ nodeId: blockId, classId: newPage.id }); } }
      );
    },
    onCreateTag: (blockId, name, _keepInline) => {
      if (!systemClassIds?.page) return;
      createNode.mutate(
        { name, classes: [systemClassIds.page] },
        { onSuccess: (newPage) => { addTag.mutate({ nodeId: blockId, tagId: newPage.id }); } }
      );
    },
    onCreatePageLink: async (name) => {
      try {
        // Check if the name is a date format — create date page instead of regular page
        const parsedDate = parseDate(name);
        if (parsedDate) {
          let dateNode;
          if (parsedDate.type === 'day' && parsedDate.month && parsedDate.day) {
            const dateStr = `${parsedDate.year}-${String(parsedDate.month).padStart(2, '0')}-${String(parsedDate.day).padStart(2, '0')}`;
            dateNode = await getOrCreateDaily(dateStr);
          } else if (parsedDate.type === 'month' && parsedDate.month) {
            dateNode = await getOrCreateMonthly(parsedDate.year, parsedDate.month);
          } else {
            dateNode = await getOrCreateYearly(parsedDate.year);
          }
          return dateNode.uuid;
        }
        
        if (!systemClassIds?.page) return undefined;
        const newPage = await createNode.mutateAsync({ name, classes: [systemClassIds.page] });
        return newPage.uuid;
      } catch (error) {
        console.error('Failed to create page for link:', error);
        return undefined;
      }
    },
    onOpenComments: (blockId) => {
      openCommentsForNode(blockId);
    },
    onAssetUpload: options.onAssetUpload,
    onOpenBacklinks: options.onOpenBacklinks,
    getCommentCount: (block) => block.comment_count ?? 0,
    getBacklinkCount: (block) => block.backlink_count ?? 0,
  }), [addClass, addTag, addTagLink, createNode, systemClassIds, openCommentsForNode, options.onOpenBacklinks, options.onAssetUpload]);
}
