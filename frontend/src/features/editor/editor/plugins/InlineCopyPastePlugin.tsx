/**
 * InlineCopyPastePlugin — Per-block copy/paste for InlineEditor.
 *
 * Adapts BlockCopyPastePlugin to work without BlockNode:
 * - COPY_COMMAND: copies [[blockUuid]] when cursor has no text selection
 * - PASTE_COMMAND: handles internal block paste and link-pill paste
 *
 * Document-level block selection copy/paste is handled by useBlockSelection.
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COPY_COMMAND,
  PASTE_COMMAND,
  COMMAND_PRIORITY_HIGH,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
} from 'lexical';

import { generateUUID } from '@/utils/uuid';
import {
  copyToClipboard,
  tryParseInternalFormat,
  analyzeClipboard,
} from '@/utils/clipboardManager';
import type { ASTDocument, ASTParagraph, ASTInlineNode } from '@/types/ast';
import { useClipboardStore } from '@/stores/clipboardStore';
import { paragraph, text as astText, buildLinkId, nodeLink } from '@/lib/astBuilder';
import { serializeContentAST } from '@/features/editor/editor/editorConfig';
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import { getUndoEngine } from '@/stores/undoEngine';
import type { MutationIntent } from '@/runtime/types';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { liveSyncManager } from '@/features/collab';

async function applyRuntimeIntent(intent: MutationIntent): Promise<void> {
  await getUndoEngine().applyIntent(intent, intent.type === 'update_content' ? { sourceEditorId: intent.sourceEditorId } : undefined);
}

interface InlineCopyPastePluginProps {
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

async function insertLinkPillAtOffset(
  targetUuid: string,
  blockId: string,
  cursorOffset: number,
): Promise<void> {
  const runtime = getOperationRuntime();
  const graphNode = getNode(runtime, blockId);
  if (!graphNode) return;

  const link = nodeLink(buildLinkId(targetUuid, generateUUID()), 'node');
  const existing = graphNode.contentAST ?? [paragraph(astText(''))];
  const existingInlines =
    existing.flatMap((p) => ('children' in p ? (p as ASTParagraph).children ?? [] : []));

  let remaining = cursorOffset;
  let splitIdx = existingInlines.length;
  let splitTextOffset = 0;
  for (let i = 0; i < existingInlines.length; i++) {
    const inline = existingInlines[i] as ASTInlineNode;
    const len =
      inline.type === 'text'
        ? inline.text?.length ?? 0
        : inline.type === 'node_link' || inline.type === 'external_link'
          ? 1
          : 0;
    if (remaining <= len) {
      splitIdx = i;
      splitTextOffset = remaining;
      break;
    }
    remaining -= len;
  }

  const before: ASTInlineNode[] = [];
  const after: ASTInlineNode[] = [];
  for (let i = 0; i < existingInlines.length; i++) {
    if (i < splitIdx) {
      before.push(existingInlines[i]);
    } else if (i === splitIdx) {
      const inline = existingInlines[i];
      if (inline.type === 'text' && splitTextOffset > 0) {
        const pre = inline.text.slice(0, splitTextOffset);
        const post = inline.text.slice(splitTextOffset);
        before.push(astText(pre));
        if (post) after.push(astText(post));
      } else {
        after.push(inline);
      }
    } else {
      after.push(existingInlines[i]);
    }
  }

  const firstBlock = existing[0];
  const newPara: ASTDocument[number] =
    firstBlock?.type === 'heading'
      ? { type: 'heading', level: (firstBlock as { level?: number }).level ?? 1, children: [...before, link, ...after] }
      : paragraph(...before, link, ...after);

  const newAST: ASTDocument = [newPara];
  const serialized = serializeContentAST(newAST);
  await applyRuntimeIntent({ type: 'update_content', blockId, contentAST: newAST });
  if (graphNode.blockId) {
    liveSyncManager.sendBlockUpdate(blockId, graphNode.blockId, serialized);
  }
  useEditorFocusStore.getState().setPendingFocus(blockId, cursorOffset + 1);
  getRuntimeEventBus().flushEvents();
}

interface PasteBlock {
  name: string;
  children?: PasteBlock[];
}

async function pasteBlockTree(
  blocks: PasteBlock[],
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

export function InlineCopyPastePlugin({ blockId, onPasteImage }: InlineCopyPastePluginProps): null {
  const [editor] = useLexicalComposerContext();
  const onPasteImageRef = useRef(onPasteImage);
  useEffect(() => {
    onPasteImageRef.current = onPasteImage;
  }, [onPasteImage]);

  // COPY_COMMAND: copy [[blockUuid]] when no text selected
  useEffect(() => {
    return editor.registerCommand<ClipboardEvent>(
      COPY_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;
        if (!selection.isCollapsed()) return false;

        const linkText = `[[${blockId}]]`;
        if (event?.clipboardData) {
          event.preventDefault();
          event.clipboardData.setData('text/plain', linkText);
        } else {
          copyToClipboard(linkText).catch(console.error);
        }
        useClipboardStore.getState().setLinkMode();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, blockId]);

  // PASTE_COMMAND: handle internal blocks, link pills, or image paste
  useEffect(() => {
    return editor.registerCommand<ClipboardEvent>(
      PASTE_COMMAND,
      (event) => {
        const clipboardData = event?.clipboardData;
        if (!clipboardData) return false;

        // Image / file paste (highest priority — must intercept before text handlers)
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
              return true;
            }
          }
          return false;
        }

        const text = clipboardData.getData('text/plain');
        if (!text) return false;

        // Link-mode paste
        const { mode: clipMode } = useClipboardStore.getState();
        if (clipMode === 'link') {
          const uuidMatch = text.match(/^\[\[([0-9a-f-]{36})\]\]$/i);
          if (uuidMatch) {
            const targetUuid = uuidMatch[1];
            let cursorOffset = 0;
            const pasteSelection = $getSelection();
            if ($isRangeSelection(pasteSelection)) {
              const anchorNode = pasteSelection.anchor.getNode();
              if ($isTextNode(anchorNode)) {
                cursorOffset = pasteSelection.anchor.offset;
              }
            }
            event.preventDefault();
            (async () => {
              await insertLinkPillAtOffset(targetUuid, blockId, cursorOffset);
            })();
            return true;
          }
        }

        // Internal blocks paste
        const blockData = tryParseInternalFormat(text);
        if (!blockData || blockData.blocks.length === 0) return false;

        const runtime = getOperationRuntime();
        const currentNode = getNode(runtime, blockId);
        if (!currentNode?.parentId) return false;

        event.preventDefault();
        const parentId = currentNode.parentId;

        (async () => {
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
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, blockId]);

  return null;
}