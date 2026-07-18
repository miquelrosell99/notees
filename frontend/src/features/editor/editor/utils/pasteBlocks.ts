/**
 * Paste block tree utilities — extracted from the legacy BlockCopyPastePlugin.
 *
 * Used by BlockRow and useBlockSelection for context-menu paste operations.
 */

import { generateUUID } from '@/utils/uuid';
import { paragraph, text as astText } from '@/lib/astBuilder';
import type { ASTDocument } from '@/types/ast';
import type { BlockCopyData, BlockData } from '@/utils/clipboardManager';
import { getWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import type { WorkspaceStore } from '@/core/store';
import { serializeContentAST } from '@/features/editor/editor/editorConfig';
import { useEditorFocusStore } from '@/stores/editorFocusStore';

function parseBlockName(name: string): ASTDocument {
  try {
    const parsed = JSON.parse(name);
    if (Array.isArray(parsed)) return parsed as ASTDocument;
  } catch {
    // fall through
  }
  return [paragraph(astText(name))];
}

/**
 * Recursively paste a tree of BlockData into the core WorkspaceStore.
 *
 * NOTE: The core store's public `moveNode` only appends children to the end of
 * the parent list. Honoring `afterBlockId` for precise sibling ordering requires
 * building a custom tree CRDT update; that is left as a TODO for Phase 6.
 *
 * @returns Array of created top-level block IDs (in insertion order)
 */
function pasteBlockTree(
  store: WorkspaceStore,
  blocks: BlockData[],
  parentId: string,
  afterBlockId: string | null,
  onContentChange?: (blockId: string, contentAST: ASTDocument) => void,
): string[] {
  const createdIds: string[] = [];

  for (const block of blocks) {
    const contentAST = parseBlockName(block.name);
    const newId = generateUUID();
    createdIds.push(newId);

    store.createNode({ nodeId: newId, kind: 'block', parentId });
    if (afterBlockId !== null) {
      // TODO: insert at the position immediately after `afterBlockId` instead of
      // appending once the core store exposes ordered insertion.
      void afterBlockId;
    }
    store.moveNode(newId, parentId);
    store.updateText(newId, (text) => {
      const serialized = serializeContentAST(contentAST);
      const current = text.toPlaintext();
      text.delete(0, current.length);
      text.insert(0, serialized);
    });

    onContentChange?.(newId, contentAST);

    if (block.children && block.children.length > 0) {
      pasteBlockTree(store, block.children, newId, null, onContentChange);
    }
  }

  return createdIds;
}

/**
 * Paste a BlockCopyData snapshot after a specific block.
 * Used by context-menu "Paste" and document-level Ctrl+V in selection mode.
 */
export async function pasteBlocksAfterBlock(
  workspaceId: string,
  blockData: BlockCopyData,
  afterBlockId: string,
  onContentChange?: (blockId: string, contentAST: ASTDocument) => void,
): Promise<void> {
  const store = getWorkspaceStore(workspaceId);
  if (!store) return;

  const afterNode = store.getNode(afterBlockId);
  if (!afterNode?.parentId) return;

  const createdIds = pasteBlockTree(
    store,
    blockData.blocks,
    afterNode.parentId,
    afterBlockId,
    onContentChange,
  );

  if (createdIds.length > 0) {
    useEditorFocusStore.getState().setPendingFocus(createdIds[createdIds.length - 1]);
  }
}
