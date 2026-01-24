/**
 * BlockCallbacksContext
 * 
 * Context for block-specific callbacks that are used in editable block mode.
 * This allows NodeCollection to render Block components with all the
 * necessary callbacks without needing to pass them through props.
 * 
 * Used by NodeContent to provide callbacks, and consumed by NodeListView
 * when rendering editable blocks.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { Node } from '@/types';
import type { AssetCategory } from '@/api/assets';

/**
 * Callbacks for block-specific operations
 */
export interface BlockCallbacks {
  /** Handle adding a class to a block */
  onAddClass?: (blockId: number, classNodeId: number, keepInline: boolean, className: string) => void;
  /** Handle adding a tag to a block */
  onAddTag?: (blockId: number, tagNodeId: number, keepInline: boolean, tagName: string) => void;
  /** Handle creating a new class */
  onCreateClass?: (blockId: number, name: string, keepInline: boolean) => void;
  /** Handle creating a new tag */
  onCreateTag?: (blockId: number, name: string, keepInline: boolean) => void;
  /** Handle creating a new page link */
  onCreatePageLink?: (name: string) => Promise<string | undefined>;
  /** Handle opening comments for a block */
  onOpenComments?: (blockId: number) => void;
  /** Handle asset upload for a block */
  onAssetUpload?: (blockId: number, assetTypesOrFile?: AssetCategory[] | File) => void;
  /** Handle opening backlinks for a block */
  onOpenBacklinks?: (blockId: number) => void;
  /** Get comment count for a block */
  getCommentCount?: (block: Node) => number;
  /** Get backlink count for a block */
  getBacklinkCount?: (block: Node) => number;
}

const BlockCallbacksContext = createContext<BlockCallbacks | null>(null);

/**
 * Provider for block callbacks
 */
export function BlockCallbacksProvider({ 
  children, 
  callbacks 
}: { 
  children: ReactNode; 
  callbacks: BlockCallbacks;
}) {
  return (
    <BlockCallbacksContext.Provider value={callbacks}>
      {children}
    </BlockCallbacksContext.Provider>
  );
}

/**
 * Hook to consume block callbacks
 * Returns null if not within a BlockCallbacksProvider (e.g., in non-editable mode)
 */
export function useBlockCallbacks(): BlockCallbacks | null {
  return useContext(BlockCallbacksContext);
}

/**
 * Hook to get block callbacks, throwing if not available
 * Use this when callbacks are required
 */
export function useBlockCallbacksRequired(): BlockCallbacks {
  const callbacks = useContext(BlockCallbacksContext);
  if (!callbacks) {
    throw new Error('useBlockCallbacksRequired must be used within a BlockCallbacksProvider');
  }
  return callbacks;
}
