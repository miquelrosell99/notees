/**
 * useQuickAdd Hook
 *
 * Shared creation logic for quick add components.
 *
 * Features:
 * - Draft block state management
 * - Block CRUD operations (add, remove, change)
 * - Keyboard handling (Enter to add, Backspace to remove)
 * - Block creation to destination page
 */

import { useState, useCallback } from "react";
import { uuidv7 } from "uuidv7";

export interface DraftBlock {
  nodeUuid: string;
  content: string;
}

export interface UseQuickAddOptions {
  /** Initial draft blocks (defaults to single empty block) */
  initialBlocks?: DraftBlock[];
  /** Callback when blocks are successfully created */
  onSuccess?: () => void;
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
  createBlocks: (destinationPageId: string) => Promise<void>;
  /** Whether creation is in progress */
  isCreating: boolean;
  /** Whether there are non-empty blocks to send */
  hasContent: boolean;
}

interface QuickAddWriter {
  createObject(partial: {
    presentAsMain?: boolean;
    parentId?: string | null;
    contentAst?: Array<{ type: "text"; text: string }>;
  }): Promise<string>;
}

/**
 * Hook for managing quick add state and operations.
 *
 * @param options - Configuration options
 * @returns Quick add state and handlers
 */
export function useQuickAdd(
  client: QuickAddWriter,
  options: UseQuickAddOptions = {},
): UseQuickAddReturn {
  const { initialBlocks = [{ nodeUuid: uuidv7(), content: "" }], onSuccess } = options;

  const [draftBlocks, setDraftBlocks] = useState<DraftBlock[]>(initialBlocks);
  const [isCreating, setIsCreating] = useState(false);

  // Reset blocks to initial state
  const resetBlocks = useCallback(() => {
    setDraftBlocks([{ nodeUuid: uuidv7(), content: "" }]);
  }, []);

  // Update a block's content
  const handleBlockChange = useCallback((blockId: string, content: string) => {
    setDraftBlocks((blocks) => blocks.map((b) => (b.nodeUuid === blockId ? { ...b, content } : b)));
  }, []);

  // Add a new empty block
  const handleAddBlock = useCallback(() => {
    setDraftBlocks((blocks) => [...blocks, { nodeUuid: uuidv7(), content: "" }]);
  }, []);

  // Remove a block (keep at least one)
  const handleRemoveBlock = useCallback((blockId: string) => {
    setDraftBlocks((blocks) => {
      if (blocks.length <= 1) return blocks;
      return blocks.filter((b) => b.nodeUuid !== blockId);
    });
  }, []);

  // Handle keyboard events in block textarea
  const handleBlockKeyDown = useCallback(
    (blockId: string, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleAddBlock();
      } else if (e.key === "Backspace") {
        const block = draftBlocks.find((b) => b.nodeUuid === blockId);
        if (block?.content === "" && draftBlocks.length > 1) {
          e.preventDefault();
          handleRemoveBlock(blockId);
        }
      }
    },
    [draftBlocks, handleAddBlock, handleRemoveBlock],
  );

  // Create blocks to a destination page
  const createBlocks = useCallback(
    async (destinationPageId: string) => {
      const nonEmptyBlocks = draftBlocks.filter((b) => b.content.trim());
      if (nonEmptyBlocks.length === 0) return;

      setIsCreating(true);
      try {
        // Create blocks sequentially, in draft order (a parented child
        // defaults to the inline body — no render bit needed).
        for (const block of nonEmptyBlocks) {
          await client.createObject({
            parentId: destinationPageId,
            contentAst: [{ type: "text", text: block.content.trim() }],
          });
        }
        resetBlocks();
        onSuccess?.();
      } finally {
        setIsCreating(false);
      }
    },
    [draftBlocks, client, resetBlocks, onSuccess],
  );

  // Check if there's any content to send
  const hasContent = draftBlocks.some((b) => b.content.trim());

  return {
    draftBlocks,
    resetBlocks,
    handleBlockChange,
    handleAddBlock,
    handleRemoveBlock,
    handleBlockKeyDown,
    createBlocks,
    isCreating,
    hasContent,
  };
}

export default useQuickAdd;
