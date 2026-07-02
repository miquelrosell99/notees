/**
 * useInlineCopyPaste — React paste handler for the custom inline editor.
 *
 * Handles image/audio/file delegation, link-pill paste, internal block paste,
 * and plain text insertion.
 */

import { useCallback, useRef, useEffect } from 'react';
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
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { getRuntimeEventBus, applyRuntimeIntent } from '@/runtime/eventBus';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { liveSyncManager } from '@/features/collab';
import { insertText, insertAtomicNode } from '../model/inlineEditorModel';
import type { InlineEditorState } from '../model/types';

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

async function pasteBlockTree(
  blocks: BlockData[],
  parentId: string,
  afterBlockId: string | null,
): Promise<string[]> {
  const createdIds: string[] = [];
  let lastAfter = afterBlockId;

  for (const block of blocks) {
    const contentAST = parseBlockName(block.name);
    const newId = generateUUID();
    createdIds.push(newId);

    await applyRuntimeIntent({
      type: 'create_block',
      parentId,
      afterBlockId: lastAfter,
      blockId: newId,
      contentAST,
    });

    lastAfter = newId;

    if (block.children && block.children.length > 0) {
      await pasteBlockTree(block.children, newId, null);
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
  const onPasteImageRef = useRef(onPasteImage);
  useEffect(() => {
    onPasteImageRef.current = onPasteImage;
  }, [onPasteImage]);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData) return;

      const analysis = analyzeClipboard(clipboardData);
      if (analysis.type === 'image' || analysis.type === 'audio' || analysis.type === 'file') {
        if (analysis.file) {
          const runtime = getOperationRuntime();
          const graphNode = getNode(runtime, blockId);
          const blockServerId = graphNode?.blockId;
          if (blockServerId != null && onPasteImageRef.current) {
            const hasContent = !isBlockEmpty(graphNode?.contentAST);
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
        const uuidMatch = text.match(/^\[\[([0-9a-f-]{36})\]\]$/i);
        if (uuidMatch) {
          event.preventDefault();
          event.stopPropagation();
          const targetUuid = uuidMatch[1];
          applyMutation((prev) =>
            insertAtomicNode(prev, nodeLink(buildLinkId(targetUuid, generateUUID()), 'node')),
          );

          const runtime = getOperationRuntime();
          const graphNode = getNode(runtime, blockId);
          if (graphNode?.blockId) {
            liveSyncManager.sendBlockUpdate(
              blockId,
              graphNode.blockId,
              serializeContentAST(stateRef.current.ast),
            );
            getRuntimeEventBus().flushEvents();
          }
          return;
        }
      }

      const blockData = tryParseInternalFormat(text);
      if (blockData && blockData.blocks.length > 0) {
        const runtime = getOperationRuntime();
        const currentNode = getNode(runtime, blockId);
        if (!currentNode?.parentId) return;

        event.preventDefault();
        event.stopPropagation();
        const parentId = currentNode.parentId;

        void (async () => {
          if (isBlockEmpty(currentNode.contentAST)) {
            const [firstBlock, ...restBlocks] = blockData.blocks;
            const firstAST = parseBlockName(firstBlock.name);
            const serializedFirst = serializeContentAST(firstAST);
            await applyRuntimeIntent({ type: 'update_content', blockId, contentAST: firstAST });
            if (currentNode.blockId) {
              liveSyncManager.sendBlockUpdate(blockId, currentNode.blockId, serializedFirst);
            }

            if (firstBlock.children && firstBlock.children.length > 0) {
              await pasteBlockTree(firstBlock.children, blockId, null);
            }

            if (restBlocks.length > 0) {
              const created = await pasteBlockTree(restBlocks, parentId, blockId);
              getRuntimeEventBus().flushEvents();
              if (created.length > 0) {
                useEditorFocusStore.getState().setPendingFocus(created[created.length - 1]);
              }
            } else {
              getRuntimeEventBus().flushEvents();
              useEditorFocusStore.getState().setPendingFocus(blockId);
            }
          } else {
            const created = await pasteBlockTree(blockData.blocks, parentId, blockId);
            getRuntimeEventBus().flushEvents();
            if (created.length > 0) {
              useEditorFocusStore.getState().setPendingFocus(created[created.length - 1]);
            }
          }

          getRuntimeEventBus().flushEvents();
        })();
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      applyMutation((prev) => insertText(prev, text));
    },
    [stateRef, applyMutation, blockId],
  );

  return handlePaste;
}
