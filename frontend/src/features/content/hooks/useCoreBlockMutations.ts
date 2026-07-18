/**
 * useCoreBlockMutations — Block-level structural mutations backed by the
 * local-first core store and its UndoManager.
 *
 * This hook replaces runtime intent application (applyIntent/getUndoEngine) for
 * the tree-overlay surface. Content is flattened to plain text because the
 * prototype core stores only a single paragraph of text per node.
 */

import { useCallback } from 'react';
import { useWorkspaceStore, useUndoManager } from '@/core/hooks';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import { paragraph, text as astText } from '@/lib/astBuilder';
import { generateUUID } from '@/utils/uuid';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import type { ASTDocument } from '@/types/ast';
import type { WorkspaceStore } from '@/core/store';
import type { UndoManager } from '@/core/undo';
import type { BlockCopyData, BlockData } from '@/utils/clipboardManager';

export interface CoreBlockMutations {
  createBlock: (args: {
    blockId?: string;
    parentId: string | null;
    afterBlockId?: string | null;
    contentAST?: ASTDocument;
  }) => Promise<string>;
  moveBlock: (args: { blockId: string; newParentId: string | null }) => Promise<void>;
  deleteBlock: (args: { blockId: string }) => Promise<void>;
  splitBlock: (args: { blockId: string; atOffset: number; newBlockId?: string }) => Promise<string>;
  mergeBlocks: (args: { sourceBlockId: string; targetBlockId: string }) => Promise<void>;
  indentBlock: (args: { blockId: string }) => Promise<void>;
  outdentBlock: (args: { blockId: string }) => Promise<void>;
  pasteBlocksAfter: (args: { afterBlockId: string; blockData: BlockCopyData }) => Promise<void>;
}

function astToPlaintext(ast: ASTDocument): string {
  return stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY });
}

function getNodePlaintext(store: WorkspaceStore, nodeId: string): string {
  const content = store.getNode(nodeId)?.content ?? '';
  try {
    const ast = JSON.parse(content) as Array<{ text?: string }>;
    if (Array.isArray(ast)) {
      return ast.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
    }
  } catch {
    // fall through
  }
  return content;
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

function requireStore(
  store: WorkspaceStore | undefined,
  manager: UndoManager | undefined,
): { store: WorkspaceStore; manager: UndoManager } {
  if (!store || !manager) throw new Error('Workspace store is not ready');
  return { store, manager };
}

export function useCoreBlockMutations(workspaceId: string | undefined): CoreBlockMutations {
  const { store } = useWorkspaceStore(workspaceId ?? '');
  const manager = useUndoManager(workspaceId ?? '');

  const createBlock = useCallback(
    async (args: {
      blockId?: string;
      parentId: string | null;
      afterBlockId?: string | null;
      contentAST?: ASTDocument;
    }): Promise<string> => {
      const { manager: m } = requireStore(store, manager);
      const blockId = args.blockId ?? generateUUID();
      const content = astToPlaintext(args.contentAST ?? []);
      m.createBlock({
        nodeId: blockId,
        kind: 'block',
        parentId: args.parentId ?? null,
        content,
      });
      if (args.afterBlockId && process.env.NODE_ENV === 'development') {
        console.warn(
          '[useCoreBlockMutations] Precise sibling ordering (afterBlockId) is not supported by the prototype core store; block appended to end of parent.',
        );
      }
      return blockId;
    },
    [store, manager],
  );

  const moveBlock = useCallback(
    async (args: { blockId: string; newParentId: string | null }): Promise<void> => {
      const { manager: m } = requireStore(store, manager);
      m.moveNode(args.blockId, args.newParentId ?? null);
    },
    [store, manager],
  );

  const deleteBlock = useCallback(
    async (args: { blockId: string }): Promise<void> => {
      const { manager: m } = requireStore(store, manager);
      m.deleteNode(args.blockId);
    },
    [store, manager],
  );

  const splitBlock = useCallback(
    async (args: { blockId: string; atOffset: number; newBlockId?: string }): Promise<string> => {
      const { store: s, manager: m } = requireStore(store, manager);
      const newBlockId = args.newBlockId ?? generateUUID();
      const plainText = getNodePlaintext(s, args.blockId);
      const before = plainText.slice(0, Math.max(0, args.atOffset));
      const after = plainText.slice(Math.max(0, args.atOffset));
      const parentId = s.getNode(args.blockId)?.parentId ?? null;

      m.updateText(args.blockId, (text) => {
        const current = text.toPlaintext();
        text.delete(0, current.length);
        text.insert(0, before);
      });
      m.createBlock({
        nodeId: newBlockId,
        kind: 'block',
        parentId,
        content: after,
      });
      return newBlockId;
    },
    [store, manager],
  );

  const mergeBlocks = useCallback(
    async (args: { sourceBlockId: string; targetBlockId: string }): Promise<void> => {
      const { manager: m } = requireStore(store, manager);
      m.mergeBlocks(args.sourceBlockId, args.targetBlockId);
    },
    [store, manager],
  );

  const indentBlock = useCallback(
    async (args: { blockId: string }): Promise<void> => {
      const { store: s, manager: m } = requireStore(store, manager);
      const node = s.getNode(args.blockId);
      if (!node?.parentId) return;
      const siblings = s.getChildren(node.parentId);
      const idx = siblings.indexOf(args.blockId);
      if (idx <= 0) return;
      const newParentId = siblings[idx - 1];
      if (!newParentId) return;
      m.moveNode(args.blockId, newParentId);
    },
    [store, manager],
  );

  const outdentBlock = useCallback(
    async (args: { blockId: string }): Promise<void> => {
      const { store: s, manager: m } = requireStore(store, manager);
      const node = s.getNode(args.blockId);
      if (!node?.parentId) return;
      const parentNode = s.getNode(node.parentId);
      m.moveNode(args.blockId, parentNode?.parentId ?? null);
    },
    [store, manager],
  );

  const pasteBlocksAfter = useCallback(
    async (args: { afterBlockId: string; blockData: BlockCopyData }): Promise<void> => {
      const { store: s, manager: m } = requireStore(store, manager);
      const afterNode = s.getNode(args.afterBlockId);
      if (!afterNode?.parentId) return;

      async function pasteTree(blocks: BlockData[], parentId: string): Promise<string[]> {
        const created: string[] = [];
        for (const block of blocks) {
          const newId = block.uuid ?? generateUUID();
          const contentAST = parseBlockName(block.name);
          const content = astToPlaintext(contentAST);
          m.createBlock({ nodeId: newId, kind: 'block', parentId, content });
          created.push(newId);
          if (block.children && block.children.length > 0) {
            await pasteTree(block.children, newId);
          }
        }
        return created;
      }

      const createdIds = await pasteTree(args.blockData.blocks, afterNode.parentId);
      if (createdIds.length > 0) {
        useEditorFocusStore.getState().setPendingFocus(createdIds[createdIds.length - 1]);
      }
    },
    [store, manager],
  );

  return {
    createBlock,
    moveBlock,
    deleteBlock,
    splitBlock,
    mergeBlocks,
    indentBlock,
    outdentBlock,
    pasteBlocksAfter,
  };
}
