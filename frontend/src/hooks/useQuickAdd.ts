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
import { useCreateNode, usePageClass } from './useNodes';
import { listNodes } from '@/api/nodes';
import { useNodesStore } from '@/stores';
import { parseHierarchicalPath, resolveHierarchicalParent } from '@/utils/hierarchicalPath';

export interface DraftBlock {
  id: number;
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
  handleBlockChange: (blockId: number, content: string) => void;
  /** Add a new empty block */
  handleAddBlock: () => void;
  /** Remove a block by ID */
  handleRemoveBlock: (blockId: number) => void;
  /** Handle keyboard events in block input (Enter/Backspace) */
  handleBlockKeyDown: (blockId: number, e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Create blocks to a destination page */
  createBlocks: (destinationPageId: number) => Promise<void>;
  /** Create a new page with given name */
  createPage: (name: string) => Promise<{ id: number } | undefined>;
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
  const {
    initialBlocks = [{ id: 1, content: '' }],
    onSuccess,
    navigateOnSuccess = false,
  } = options;

  const [draftBlocks, setDraftBlocks] = useState<DraftBlock[]>(initialBlocks);
  const [nextBlockId, setNextBlockId] = useState(
    Math.max(...initialBlocks.map(b => b.id), 0) + 1
  );
  
  const createNodeMutation = useCreateNode();
  const { openNode } = useNodesStore();
  const { pageClassId } = usePageClass();

  // Reset blocks to initial state
  const resetBlocks = useCallback(() => {
    setDraftBlocks([{ id: nextBlockId, content: '' }]);
    setNextBlockId(id => id + 1);
  }, [nextBlockId]);

  // Update a block's content
  const handleBlockChange = useCallback((blockId: number, content: string) => {
    setDraftBlocks(blocks =>
      blocks.map(b => (b.id === blockId ? { ...b, content } : b))
    );
  }, []);

  // Add a new empty block
  const handleAddBlock = useCallback(() => {
    setDraftBlocks(blocks => [...blocks, { id: nextBlockId, content: '' }]);
    setNextBlockId(id => id + 1);
  }, [nextBlockId]);

  // Remove a block (keep at least one)
  const handleRemoveBlock = useCallback((blockId: number) => {
    setDraftBlocks(blocks => {
      if (blocks.length <= 1) return blocks;
      return blocks.filter(b => b.id !== blockId);
    });
  }, []);

  // Handle keyboard events in block textarea
  const handleBlockKeyDown = useCallback(
    (blockId: number, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleAddBlock();
      } else if (e.key === 'Backspace') {
        const block = draftBlocks.find(b => b.id === blockId);
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
    async (destinationPageId: number) => {
      const nonEmptyBlocks = draftBlocks.filter(b => b.content.trim());
      if (nonEmptyBlocks.length === 0) return;

      // Create blocks sequentially
      for (const block of nonEmptyBlocks) {
        await createNodeMutation.mutateAsync({
          name: block.content.trim(),
          parent_id: destinationPageId,
        });
      }

      // Reset blocks
      resetBlocks();

      // Navigate if requested
      if (navigateOnSuccess) {
        openNode(destinationPageId, 'page');
      }

      // Call success callback
      onSuccess?.();
    },
    [draftBlocks, createNodeMutation, resetBlocks, navigateOnSuccess, openNode, onSuccess]
  );

  // Create a new page (supports hierarchical paths like "Page1/Page2")
  const createPage = useCallback(
    async (name: string) => {
      if (!name.trim() || !pageClassId) return undefined;
      
      const trimmedName = name.trim();
      const parsed = parseHierarchicalPath(trimmedName);
      
      let parentId: number | null = null;
      
      // If hierarchical path, resolve parent (creating intermediate pages if needed)
      if (parsed.isHierarchical) {
        // Fetch fresh pages from API to avoid stale cache issues
        const freshPages = await listNodes({ pages_only: true, include_children: true });
        parentId = await resolveHierarchicalParent(
          parsed.parentSegments,
          freshPages,
          async (segmentName, parentIdForCreation) => {
            return await createNodeMutation.mutateAsync({
              name: segmentName,
              classes: [pageClassId],
              parent_id: parentIdForCreation,
            });
          }
        );
      }
      
      // Create the final page with resolved parent
      const newPage = await createNodeMutation.mutateAsync({
        name: parsed.leaf || trimmedName,
        classes: [pageClassId],
        parent_id: parentId,
      });
      
      if (navigateOnSuccess) {
        openNode(newPage.id, 'page');
      }
      
      onSuccess?.();
      
      return newPage;
    },
    [createNodeMutation, navigateOnSuccess, openNode, onSuccess, pageClassId]
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
