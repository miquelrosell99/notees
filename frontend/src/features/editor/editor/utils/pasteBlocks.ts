/**
 * Paste block tree utilities — extracted from the legacy BlockCopyPastePlugin.
 *
 * Used by BlockRow and useBlockSelection for context-menu paste operations.
 */

import { generateUUID } from '@/utils/uuid';
import { paragraph, text as astText } from '@/lib/astBuilder';
import type { ASTDocument } from '@/types/ast';
import type { BlockCopyData, BlockData } from '@/utils/clipboardManager';
import { getWorkspaceStoreClient } from '@/core/adapters/workspaceStoreClientAdapter';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import type { UndoManagerClient } from '@/core/hooks/useUndoManager';
import { serializeContentAST } from '@/features/editor/editor/editorConfig';

function parseBlockName(name: string): ASTDocument {
  try {
    const parsed = JSON.parse(name);
    if (Array.isArray(parsed)) return parsed as ASTDocument;
  } catch {
    // fall through
  }
  return [paragraph(astText(name))];
}

function createUndoManagerClient(client: IWorkspaceStoreClient): UndoManagerClient {
  return {
    createNode: async (args) => client.mutate<void>('recordCreateNode', [args]),
    createBlock: async (args) => client.mutate<void>('recordCreateBlock', [args]),
    deleteNode: async (nodeId) => client.mutate<void>('recordDeleteNode', [nodeId]),
    moveNode: async (nodeId, newParentId) => client.mutate<void>('recordMoveNode', [nodeId, newParentId]),
    mergeBlocks: async (sourceBlockId, targetBlockId) =>
      client.mutate<void>('recordMergeBlocks', [sourceBlockId, targetBlockId]),
    setProperty: async (args) => client.mutate<void>('recordSetProperty', [args]),
    unsetProperty: async (args) => client.mutate<void>('recordUnsetProperty', [args]),
    assignClass: async (nodeId, classId) => client.mutate<void>('recordAssignClass', [nodeId, classId]),
    unassignClass: async (nodeId, classId) => client.mutate<void>('recordUnassignClass', [nodeId, classId]),
    recordSetNodeText: async (nodeId, value) => client.mutate<void>('recordSetNodeText', [nodeId, value]),
    undo: async () => client.mutate('undo', []),
    redo: async () => client.mutate('redo', []),
    canUndo: async () => {
      const result = await client.query<{ canUndo: boolean; canRedo: boolean }>('canUndo', []);
      return result.canUndo;
    },
    canRedo: async () => {
      const result = await client.query<{ canUndo: boolean; canRedo: boolean }>('canUndo', []);
      return result.canRedo;
    },
    clear: async () => client.mutate<void>('clearUndoHistory', []),
    getStacks: async () => client.query<{ undo: { label: string; timestamp: number }[]; redo: { label: string; timestamp: number }[] }>('getUndoStacks', []),
    subscribe: (listener) => client.subscribe(null, () => listener({ type: 'stack_changed' })),
  };
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
async function pasteBlockTree(
  client: IWorkspaceStoreClient,
  manager: UndoManagerClient,
  blocks: BlockData[],
  parentId: string,
  afterBlockId: string | null,
  onContentChange?: (blockId: string, contentAST: ASTDocument) => void,
): Promise<string[]> {
  const createdIds: string[] = [];

  for (const block of blocks) {
    const contentAST = parseBlockName(block.name);
    const newId = generateUUID();
    createdIds.push(newId);

    const content = serializeContentAST(contentAST);
    await manager.createBlock({ nodeId: newId, kind: 'block', parentId, content });
    if (afterBlockId !== null) {
      // TODO: insert at the position immediately after `afterBlockId` instead of
      // appending once the core store exposes ordered insertion.
      void afterBlockId;
    }
    await manager.moveNode(newId, parentId);

    onContentChange?.(newId, contentAST);

    if (block.children && block.children.length > 0) {
      await pasteBlockTree(client, manager, block.children, newId, null, onContentChange);
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
  const client = getWorkspaceStoreClient(workspaceId);
  if (!client) return;

  const afterNode = await client.query<{ parentId: string | null } | undefined>('getNode', [afterBlockId]);
  if (!afterNode?.parentId) return;

  const manager = createUndoManagerClient(client);
  const createdIds = await pasteBlockTree(
    client,
    manager,
    blockData.blocks,
    afterNode.parentId,
    afterBlockId,
    onContentChange,
  );

  if (createdIds.length > 0) {
    useEditorFocusStore.getState().setPendingFocus(createdIds[createdIds.length - 1]);
  }
}
