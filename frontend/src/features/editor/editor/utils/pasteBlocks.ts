/**
 * Paste block tree utilities — extracted from the legacy BlockCopyPastePlugin.
 *
 * Used by BlockRow and useBlockSelection for context-menu paste operations.
 */

import { generateUUID } from '@/utils/uuid';
import { paragraph, text as astText } from '@/lib/astBuilder';
import type { ASTDocument } from '@/types/ast';
import type { BlockCopyData, BlockData } from '@/utils/clipboardManager';
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import { getUndoEngine } from '@/stores/undoEngine';
import type { MutationIntent } from '@/runtime/types';
import { useEditorFocusStore } from '@/stores/editorFocusStore';

function applyRuntimeIntent(intent: MutationIntent): void {
  getUndoEngine().applyIntent(intent, intent.type === 'update_content' ? { sourceEditorId: intent.sourceEditorId } : undefined);
}

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
 * Recursively paste a tree of BlockData into the runtime.
 *
 * @returns Array of created top-level block IDs (in insertion order)
 */
function pasteBlockTree(
  blocks: BlockData[],
  parentId: string,
  afterBlockId: string | null,
  onContentChange?: (blockId: string, contentAST: ASTDocument) => void,
): string[] {
  const createdIds: string[] = [];
  let lastAfter = afterBlockId;

  for (const block of blocks) {
    const contentAST = parseBlockName(block.name);
    const newId = generateUUID();
    createdIds.push(newId);

    applyRuntimeIntent({
      type: 'create_block',
      parentId,
      afterBlockId: lastAfter,
      blockId: newId,
      contentAST,
    });

    onContentChange?.(newId, contentAST);
    lastAfter = newId;

    if (block.children && block.children.length > 0) {
      pasteBlockTree(block.children, newId, null, onContentChange);
    }
  }

  return createdIds;
}

/**
 * Paste a BlockCopyData snapshot after a specific block.
 * Used by context-menu "Paste" and document-level Ctrl+V in selection mode.
 */
export function pasteBlocksAfterBlock(
  blockData: BlockCopyData,
  afterBlockId: string,
  onContentChange?: (blockId: string, contentAST: ASTDocument) => void,
): void {
  const runtime = getOperationRuntime();
  const afterNode = getNode(runtime, afterBlockId);
  if (!afterNode?.parentId) return;

  const createdIds = pasteBlockTree(
    blockData.blocks,
    afterNode.parentId,
    afterBlockId,
    onContentChange,
  );

  getRuntimeEventBus().flushEvents();
  if (createdIds.length > 0) {
    useEditorFocusStore.getState().setPendingFocus(createdIds[createdIds.length - 1]);
    getRuntimeEventBus().flushEvents();
  }
}