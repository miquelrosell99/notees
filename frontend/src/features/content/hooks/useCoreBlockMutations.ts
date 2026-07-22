/**
 * useCoreBlockMutations — Block-level structural mutations backed by the
 * local-first core store and its UndoManager.
 *
 * This hook replaces runtime intent application (applyIntent/getUndoEngine) for
 * the tree-overlay surface. Content is flattened to plain text because the
 * prototype core stores only a single paragraph of text per node.
 */

import { useCallback } from 'react';
import { useWorkspaceStoreClient, useUndoManager } from '@/core/hooks';
import type { UndoManagerClient } from '@/core/hooks/useUndoManager';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import { paragraph, text as astText } from '@/lib/astBuilder';
import { generateUUID } from '@/utils/uuid';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import type { ASTDocument } from '@/types/ast';
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

async function getNodePlaintext(
  client: IWorkspaceStoreClient,
  nodeId: string,
): Promise<string> {
  const node = await client.query<{ content: string } | undefined>('getNode', [nodeId]);
  const content = node?.content ?? '';
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

function requireClientAndManager(
  client: IWorkspaceStoreClient | undefined,
  manager: UndoManagerClient | undefined,
): { client: IWorkspaceStoreClient; manager: UndoManagerClient } {
  if (!client || !manager) throw new Error('Workspace store is not ready');
  return { client, manager };
}

export function useCoreBlockMutations(workspaceId: string | undefined): CoreBlockMutations {
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');
  const manager = useUndoManager(workspaceId ?? '');

  const createBlock = useCallback(
    async (args: {
      blockId?: string;
      parentId: string | null;
      afterBlockId?: string | null;
      contentAST?: ASTDocument;
    }): Promise<string> => {
      const { manager: m } = requireClientAndManager(client, manager);
      const blockId = args.blockId ?? generateUUID();
      const content = astToPlaintext(args.contentAST ?? []);
      await m.createBlock({
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
    [client, manager],
  );

  const moveBlock = useCallback(
    async (args: { blockId: string; newParentId: string | null }): Promise<void> => {
      const { manager: m } = requireClientAndManager(client, manager);
      await m.moveNode(args.blockId, args.newParentId ?? null);
    },
    [client, manager],
  );

  const deleteBlock = useCallback(
    async (args: { blockId: string }): Promise<void> => {
      const { manager: m } = requireClientAndManager(client, manager);
      await m.deleteNode(args.blockId);
    },
    [client, manager],
  );

  const splitBlock = useCallback(
    async (args: { blockId: string; atOffset: number; newBlockId?: string }): Promise<string> => {
      const { client: c, manager: m } = requireClientAndManager(client, manager);
      const newBlockId = args.newBlockId ?? generateUUID();
      const plainText = await getNodePlaintext(c, args.blockId);
      const before = plainText.slice(0, Math.max(0, args.atOffset));
      const after = plainText.slice(Math.max(0, args.atOffset));
      const node = await c.query<{ parentId: string | null } | undefined>('getNode', [args.blockId]);
      const parentId = node?.parentId ?? null;

      await m.recordSetNodeText(args.blockId, before);
      await m.createBlock({
        nodeId: newBlockId,
        kind: 'block',
        parentId,
        content: after,
      });
      return newBlockId;
    },
    [client, manager],
  );

  const mergeBlocks = useCallback(
    async (args: { sourceBlockId: string; targetBlockId: string }): Promise<void> => {
      const { manager: m } = requireClientAndManager(client, manager);
      await m.mergeBlocks(args.sourceBlockId, args.targetBlockId);
    },
    [client, manager],
  );

  const indentBlock = useCallback(
    async (args: { blockId: string }): Promise<void> => {
      const { client: c, manager: m } = requireClientAndManager(client, manager);
      const node = await c.query<{ parentId: string | null } | undefined>('getNode', [args.blockId]);
      if (!node?.parentId) return;
      const siblings = await c.query<string[]>('getChildren', [node.parentId]);
      const idx = siblings.indexOf(args.blockId);
      if (idx <= 0) return;
      const newParentId = siblings[idx - 1];
      if (!newParentId) return;
      await m.moveNode(args.blockId, newParentId);
    },
    [client, manager],
  );

  const outdentBlock = useCallback(
    async (args: { blockId: string }): Promise<void> => {
      const { client: c, manager: m } = requireClientAndManager(client, manager);
      const node = await c.query<{ parentId: string | null } | undefined>('getNode', [args.blockId]);
      if (!node?.parentId) return;
      const parentNode = await c.query<{ parentId: string | null } | undefined>('getNode', [node.parentId]);
      await m.moveNode(args.blockId, parentNode?.parentId ?? null);
    },
    [client, manager],
  );

  const pasteBlocksAfter = useCallback(
    async (args: { afterBlockId: string; blockData: BlockCopyData }): Promise<void> => {
      const { client: c, manager: m } = requireClientAndManager(client, manager);
      const afterNode = await c.query<{ parentId: string | null } | undefined>('getNode', [args.afterBlockId]);
      if (!afterNode?.parentId) return;

      async function pasteTree(blocks: BlockData[], parentId: string): Promise<string[]> {
        const created: string[] = [];
        for (const block of blocks) {
          const newId = block.uuid ?? generateUUID();
          const contentAST = parseBlockName(block.name);
          const content = astToPlaintext(contentAST);
          await m.createBlock({ nodeId: newId, kind: 'block', parentId, content });
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
    [client, manager],
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
