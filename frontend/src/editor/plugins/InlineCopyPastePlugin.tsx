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

import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { generateUUID } from '@/utils/uuid';
import {
  copyToClipboard,
  tryParseInternalFormat,
} from '@/utils/clipboardManager';
import type { ASTDocument, ASTParagraph, ASTInlineNode } from '@/types/ast';
import { useClipboardStore } from '@/stores/clipboardStore';
import { paragraph, text as astText, buildLinkId, nodeLink } from '@/lib/astBuilder';
import { serializeContentAST } from '@/editor/editorConfig';

interface InlineCopyPastePluginProps {
  blockId: string;
  onContentChange?: (blockId: string, content: string) => void;
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

function insertLinkPillAtOffset(
  targetUuid: string,
  blockId: string,
  cursorOffset: number,
  onContentChange?: (blockId: string, content: string) => void,
): void {
  const runtime = getNodeGraphRuntime();
  const graphNode = runtime.getNode(blockId);
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
  runtime.applyIntent({ type: 'update_content', blockId, contentAST: newAST });
  onContentChange?.(blockId, serializeContentAST(newAST));
  runtime.requestFocus(blockId, cursorOffset + 1);
  runtime.flushEvents();
}

interface PasteBlock {
  name: string;
  children?: PasteBlock[];
}

function pasteBlockTree(
  blocks: PasteBlock[],
  parentId: string,
  afterBlockId: string | null,
  onContentChange?: (blockId: string, content: string) => void,
): string[] {
  const runtime = getNodeGraphRuntime();
  const createdIds: string[] = [];
  let lastAfter = afterBlockId;

  for (const block of blocks) {
    const contentAST = parseBlockName(block.name);
    const newId = generateUUID();
    createdIds.push(newId);

    runtime.applyIntent({
      type: 'create_block',
      parentId,
      afterBlockId: lastAfter,
      blockId: newId,
      contentAST,
    });

    onContentChange?.(newId, serializeContentAST(contentAST));
    lastAfter = newId;

    if (block.children && block.children.length > 0) {
      pasteBlockTree(block.children, newId, null, onContentChange);
    }
  }

  return createdIds;
}

export function InlineCopyPastePlugin({ blockId, onContentChange }: InlineCopyPastePluginProps): null {
  const [editor] = useLexicalComposerContext();
  const onContentChangeRef = useRef(onContentChange);
  useEffect(() => {
    onContentChangeRef.current = onContentChange;
  }, [onContentChange]);

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

  // PASTE_COMMAND: handle internal blocks or link pills
  useEffect(() => {
    return editor.registerCommand<ClipboardEvent>(
      PASTE_COMMAND,
      (event) => {
        const clipboardData = event?.clipboardData;
        if (!clipboardData) return false;
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
            insertLinkPillAtOffset(targetUuid, blockId, cursorOffset, onContentChangeRef.current);
            return true;
          }
        }

        // Internal blocks paste
        const blockData = tryParseInternalFormat(text);
        if (!blockData || blockData.blocks.length === 0) return false;

        const runtime = getNodeGraphRuntime();
        const currentNode = runtime.getNode(blockId);
        if (!currentNode?.parentId) return false;

        event.preventDefault();
        const ocRef = onContentChangeRef.current;
        const parentId = currentNode.parentId;

        if (isBlockEmpty(currentNode.contentAST)) {
          const [firstBlock, ...restBlocks] = blockData.blocks;
          const firstAST = parseBlockName(firstBlock.name);
          runtime.applyIntent({ type: 'update_content', blockId, contentAST: firstAST });
          ocRef?.(blockId, serializeContentAST(firstAST));

          if (firstBlock.children && firstBlock.children.length > 0) {
            pasteBlockTree(firstBlock.children, blockId, null, ocRef);
          }

          if (restBlocks.length > 0) {
            const created = pasteBlockTree(restBlocks, parentId, blockId, ocRef);
            runtime.flushEvents();
            if (created.length > 0) {
              runtime.requestFocus(created[created.length - 1]);
            }
          } else {
            runtime.flushEvents();
            runtime.requestFocus(blockId);
          }
        } else {
          const created = pasteBlockTree(blockData.blocks, parentId, blockId, ocRef);
          runtime.flushEvents();
          if (created.length > 0) {
            runtime.requestFocus(created[created.length - 1]);
          }
        }

        runtime.flushEvents();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, blockId]);

  return null;
}
