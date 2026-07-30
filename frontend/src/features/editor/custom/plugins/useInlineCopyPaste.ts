/**
 * useInlineCopyPaste — React paste handler for the custom inline editor.
 *
 * Handles image/audio/file delegation, link-pill paste, internal block paste,
 * and plain text insertion through the core WorkspaceStore.
 */

import { useCallback, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { generateUUID } from '@/utils/uuid';
import {
  tryParseInternalFormat,
  analyzeClipboard,
  type BlockData,
} from '@/utils/clipboardManager';
import type { ASTDocument } from '@/types/ast';
import { useClipboardStore } from '@/stores/clipboardStore';
import { paragraph, text as astText, buildLinkId, nodeLink } from '@/lib/astBuilder';
import { serializeContentAST } from '@/features/editor/editor/editorConfig';
import { useWorkspaceStoreClient, useUndoManager } from '@/core/hooks';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { insertText, insertAtomicNode } from '../model/inlineEditorModel';
import type { InlineEditorState } from '../model/types';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import type { UndoManagerClient } from '@/core/hooks/useUndoManager';

interface UseInlineCopyPasteProps {
  stateRef: React.MutableRefObject<InlineEditorState>;
  applyMutation: (mutator: (prev: InlineEditorState) => InlineEditorState) => void;
  blockId: string;
  onPasteImage?: (blockServerId: string, file: File, hasContent: boolean) => void;
}

function isBlockEmpty(contentAST: ASTDocument | null | undefined): boolean {
  if (!contentAST || contentAST.length === 0) return true;
  if (
    contentAST.length === 1 &&
    contentAST[0].type === 'paragraph' &&
    (!contentAST[0].children ||
      contentAST[0].children.length === 0 ||
      (contentAST[0].children.length === 1 &&
        contentAST[0].children[0].type === 'text' &&
        !contentAST[0].children[0].text?.trim()))
  ) {
    return true;
  }
  return false;
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
 * Recursively create a tree of blocks under `parentId`.
 *
 * NOTE: Ordered insertion after a specific sibling is not exposed by the public
 * core store API yet; `moveNode` appends to the parent. A TODO marks where a
 * tree-CRDT update should be used once available.
 */
async function createBlockTree(
  client: IWorkspaceStoreClient,
  manager: UndoManagerClient,
  parentId: string,
  blocks: BlockData[],
  afterBlockId: string | null,
): Promise<string[]> {
  const createdIds: string[] = [];

  for (const block of blocks) {
    const contentAST = parseBlockName(block.name);
    const newId = generateUUID();
    createdIds.push(newId);

    const content = serializeContentAST(contentAST);
    await manager.createBlock({ nodeId: newId, kind: 'block', parentId, content });
    if (afterBlockId !== null) {
      // TODO: ordered insertion after `afterBlockId` requires a custom tree update.
      void afterBlockId;
    }
    await manager.moveNode(newId, parentId);

    if (block.children && block.children.length > 0) {
      await createBlockTree(client, manager, newId, block.children, null);
    }
  }

  return createdIds;
}

export function useInlineCopyPaste({
  stateRef,
  applyMutation,
  blockId,
  onPasteImage,
}: UseInlineCopyPasteProps): (event: React.ClipboardEvent<HTMLDivElement>) => void {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');
  const manager = useUndoManager(workspaceId ?? '');
  const onPasteImageRef = useRef(onPasteImage);
  useEffect(() => {
    onPasteImageRef.current = onPasteImage;
  }, [onPasteImage]);

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent<HTMLDivElement>) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData) return;
      if (!client || !manager) return;

      const analysis = analyzeClipboard(clipboardData);
      if (analysis.type === 'image' || analysis.type === 'audio' || analysis.type === 'file') {
        if (analysis.file) {
          const node = await client.query<{ id: string } | undefined>('getNode', [blockId]);
          const blockServerId = node?.id ?? blockId;
          if (onPasteImageRef.current) {
            const hasContent = !isBlockEmpty(stateRef.current.ast);
            onPasteImageRef.current(blockServerId, analysis.file, hasContent);
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
        return;
      }

      const text = clipboardData.getData('text/plain');
      if (!text) return;

      const { mode: clipMode } = useClipboardStore.getState();
      if (clipMode === 'link') {
        const linkIdMatch = text.match(/^([0-9a-f-]{36})(?::([0-9a-f-]{36}))?$/i);
        if (linkIdMatch) {
          event.preventDefault();
          event.stopPropagation();
          const targetUuid = linkIdMatch[1];
          const linkUuid = linkIdMatch[2] ?? generateUUID();
          applyMutation((prev) =>
            insertAtomicNode(prev, nodeLink(buildLinkId(targetUuid, linkUuid), 'node')),
          );
          return;
        }
      }

      const blockData = tryParseInternalFormat(text);
      if (blockData && blockData.blocks.length > 0) {
        const currentNode = await client.query<{ parentId: string | null } | undefined>('getNode', [blockId]);
        if (!currentNode?.parentId) return;

        event.preventDefault();
        event.stopPropagation();
        const parentId = currentNode.parentId;

        if (isBlockEmpty(stateRef.current.ast)) {
          const [firstBlock, ...restBlocks] = blockData.blocks;
          const firstAST = parseBlockName(firstBlock.name);

          await manager.recordSetNodeText(blockId, serializeContentAST(firstAST));

          if (firstBlock.children && firstBlock.children.length > 0) {
            await createBlockTree(client, manager, blockId, firstBlock.children, null);
          }

          if (restBlocks.length > 0) {
            const created = await createBlockTree(client, manager, parentId, restBlocks, blockId);
            if (created.length > 0) {
              useEditorFocusStore.getState().setPendingFocus(created[created.length - 1]);
            }
          } else {
            useEditorFocusStore.getState().setPendingFocus(blockId);
          }
        } else {
          const created = await createBlockTree(client, manager, parentId, blockData.blocks, blockId);
          if (created.length > 0) {
            useEditorFocusStore.getState().setPendingFocus(created[created.length - 1]);
          }
        }
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      applyMutation((prev) => insertText(prev, text));
    },
    [stateRef, applyMutation, blockId, client, manager],
  );

  return handlePaste;
}
