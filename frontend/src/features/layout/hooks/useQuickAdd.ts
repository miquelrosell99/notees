/**
 * useQuickAdd Hook
 * 
 * Shared creation logic for quick add components.
 * Used by:
 * - QuickAddDialog (full modal with destination picker)
 * - QuickAddPanel (compact panel with preset destination)
 * 
 * Features:
 * - Draft block state management
 * - Block CRUD operations (add, remove, change)
 * - Keyboard handling (Enter to add, Backspace to remove)
 * - Block creation to destination page
 * - Hierarchical page creation support (e.g., "Page1/Page2")
 */
import { useState, useCallback } from 'react';
import { useCreateNode, usePageClass } from '@/features/content';
import { generateUUID } from '@/utils/uuid';
import type { Node } from '@/types';
import { listCorePagesAsync } from '@/core/query/listPages';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useOpenNode } from '@/features/layout';
import { parseHierarchicalPath, resolveHierarchicalParentUuid } from '@/utils/hierarchicalPath';

export interface DraftBlock {
  nodeUuid: string;
  content: string;
}

export interface UseQuickAddOptions {
  /** Initial draft blocks (defaults to single empty block) */
  initialBlocks?: DraftBlock[];
  /** Callback when blocks are successfully created */
  onSuccess?: () => void;
  /** Whether to navigate to the destination after creation */
  navigateOnSuccess?: boolean;
}

export interface UseQuickAddReturn {
  /** Current draft blocks */
  draftBlocks: DraftBlock[];
  /** Reset draft blocks to initial state */
  resetBlocks: () => void;
  /** Update a specific block's content */
  handleBlockChange: (blockId: string, content: string) => void;
  /** Add a new empty block */
  handleAddBlock: () => void;
  /** Remove a block by ID */
  handleRemoveBlock: (blockId: string) => void;
  /** Handle keyboard events in block input (Enter/Backspace) */
  handleBlockKeyDown: (blockId: string, e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Create blocks to a destination page */
  createBlocks: (destinationPageUuid: string) => Promise<void>;
  /** Create a new page with given name */
  createPage: (name: string) => Promise<Node | undefined>;
  /** Whether creation is in progress */
  isCreating: boolean;
  /** Whether there are non-empty blocks to send */
  hasContent: boolean;
}

/**
 * Hook for managing quick add state and operations.
 * 
 * @param options - Configuration options
 * @returns Quick add state and handlers
 * 
 * @example
 * // Basic usage
 * const { draftBlocks, handleBlockChange, createBlocks } = useQuickAdd();
 * 
 * @example
 * // With callback
 * const { createBlocks } = useQuickAdd({
 *   onSuccess: () => closePanel(),
 *   navigateOnSuccess: true,
 * });
 */
export function useQuickAdd(options: UseQuickAddOptions = {}): UseQuickAddReturn {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const {
    initialBlocks = [{ nodeUuid: generateUUID(), content: '' }],
    onSuccess,
    navigateOnSuccess = false,
  } = options;

  const [draftBlocks, setDraftBlocks] = useState<DraftBlock[]>(initialBlocks);

  const createNodeMutation = useCreateNode();
  const openNode = useOpenNode();
  const { pageClassUuid } = usePageClass();

  // Reset blocks to initial state
  const resetBlocks = useCallback(() => {
    setDraftBlocks([{ nodeUuid: generateUUID(), content: '' }]);
  }, []);

  // Update a block's content
  const handleBlockChange = useCallback((blockId: string, content: string) => {
    setDraftBlocks(blocks =>
      blocks.map(b => (b.nodeUuid === blockId ? { ...b, content } : b))
    );
  }, []);

  // Add a new empty block
  const handleAddBlock = useCallback(() => {
    setDraftBlocks(blocks => [...blocks, { nodeUuid: generateUUID(), content: '' }]);
  }, []);

  // Remove a block (keep at least one)
  const handleRemoveBlock = useCallback((blockId: string) => {
    setDraftBlocks(blocks => {
      if (blocks.length <= 1) return blocks;
      return blocks.filter(b => b.nodeUuid !== blockId);
    });
  }, []);

  // Handle keyboard events in block textarea
  const handleBlockKeyDown = useCallback(
    (blockId: string, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleAddBlock();
      } else if (e.key === 'Backspace') {
        const block = draftBlocks.find(b => b.nodeUuid === blockId);
        if (block?.content === '' && draftBlocks.length > 1) {
          e.preventDefault();
          handleRemoveBlock(blockId);
        }
      }
    },
    [draftBlocks, handleAddBlock, handleRemoveBlock]
  );

  // Create blocks to a destination page
  const createBlocks = useCallback(
    async (destinationPageUuid: string) => {
      const nonEmptyBlocks = draftBlocks.filter(b => b.content.trim());
      if (nonEmptyBlocks.length === 0) return;

      // Create blocks sequentially
      for (const block of nonEmptyBlocks) {
        await createNodeMutation.mutateAsync({
          name: block.content.trim(),
          parent_uuid: destinationPageUuid,
        });
      }

      // Reset blocks
      resetBlocks();

      // Navigate if requested
      if (navigateOnSuccess) {
        openNode(destinationPageUuid);
      }

      // Call success callback
      onSuccess?.();
    },
    [draftBlocks, createNodeMutation, resetBlocks, navigateOnSuccess, openNode, onSuccess]
  );

  // Create a new page (supports hierarchical paths like "Page1/Page2")
  const createPage = useCallback(
    async (name: string) => {
      if (!name.trim() || !pageClassUuid) return undefined;
      
      const trimmedName = name.trim();
      const parsed = parseHierarchicalPath(trimmedName);
      
      let parentUuid: string | null = null;

      // If hierarchical path, resolve parent (creating intermediate pages if needed)
      if (parsed.isHierarchical) {
        // Fetch fresh pages from the local-first store to resolve hierarchy.
        const freshPages = workspaceUuid ? await listCorePagesAsync(workspaceUuid) : [];
        parentUuid = await resolveHierarchicalParentUuid(
          parsed.parentSegments,
          freshPages,
          async (segmentName, parentUuidForCreation) => {
            return await createNodeMutation.mutateAsync({
              name: segmentName,
              class_uuids: [pageClassUuid],
              parent_uuid: parentUuidForCreation,
            });
          }
        );
      }

      // Create the final page with resolved parent
      const newPage = await createNodeMutation.mutateAsync({
        name: parsed.leaf || trimmedName,
        class_uuids: [pageClassUuid],
        parent_uuid: parentUuid,
      });
      
      if (navigateOnSuccess) {
        openNode(newPage.uuid);
      }
      
      onSuccess?.();
      
      return newPage;
    },
    [createNodeMutation, navigateOnSuccess, openNode, onSuccess, pageClassUuid]
  );

  // Check if there's any content to send
  const hasContent = draftBlocks.some(b => b.content.trim());

  return {
    draftBlocks,
    resetBlocks,
    handleBlockChange,
    handleAddBlock,
    handleRemoveBlock,
    handleBlockKeyDown,
    createBlocks,
    createPage,
    isCreating: createNodeMutation.isPending,
    hasContent,
  };
}

export default useQuickAdd;
