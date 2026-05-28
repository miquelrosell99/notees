/**
 * BlockCopyPastePlugin — Structural block copy/paste with full AST fidelity.
 *
 * This plugin implements three copy modes and two paste modes:
 *
 * ── Copy modes ──────────────────────────────────────────────────────────────
 *
 * 1. Block copy (selection mode — editor blurred, one or more blocks selected)
 *    Ctrl+C (document-level, no editor focus):
 *    → Captures selected block(s) + all children from runtime as BlockCopyData
 *    → Writes JSON to system clipboard + updates clipboardStore (mode='blocks')
 *
 * 2. Block-link copy (edit mode — cursor in block, no text selected)
 *    Ctrl+C intercepted via Lexical COPY_COMMAND:
 *    → Copies [[blockUuid]] to system clipboard
 *    → Updates clipboardStore (mode='link')
 *    → Browser native copy is suppressed
 *
 * 3. Text copy (edit mode — text is selected)
 *    NOT intercepted — the browser handles it normally.
 *
 * ── Paste modes ─────────────────────────────────────────────────────────────
 *
 * Paste is context-aware: the target block's state determines behaviour.
 *
 * A. Paste onto empty block (edit mode)
 *    Ctrl+V via Lexical PASTE_COMMAND (HIGH priority):
 *    → If clipboard contains internal-blocks JSON:
 *      - First pasted block's content replaces the empty block
 *      - Children of the first block become children of that block
 *      - Remaining top-level blocks are inserted as siblings after it
 *
 * B. Paste after a block with content (edit mode)
 *    Ctrl+V via Lexical PASTE_COMMAND (HIGH priority):
 *    → If clipboard contains internal-blocks JSON:
 *      - All pasted blocks are inserted as siblings after the current block
 *
 * C. Paste after selected block(s) (selection mode — editor blurred)
 *    Ctrl+V (document-level):
 *    → Reads from clipboardStore (sync) or system clipboard (async fallback)
 *    → Inserts pasted blocks after the last top-level selected block
 *
 * Context-menu "Copy" and "Paste" actions are wired separately via
 * ContextMenuPlugin / NodeContextMenu callbacks and call
 * copyRuntimeBlocksToClipboard / pasteBlocksAfterBlock directly.
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

import { $isBlockNode } from '../nodes/BlockNode';
import { $isInlineLinkNode } from '../nodes/InlineLinkNode';
import { findParentNodeBlock } from '../utils/selectionUtils';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { generateUUID } from '../../utils/uuid';
import {
  copyToClipboard,
  tryParseInternalFormat,
  copyRuntimeBlocksToClipboard,
  type BlockCopyData,
  type BlockData,
} from '../../utils/clipboardManager';
import { useClipboardStore } from '../../stores/clipboardStore';
import { paragraph, text as astText, buildLinkId, nodeLink } from '../../lib/astBuilder';
import type { ASTDocument, ASTInlineNode } from '../../types/ast';

// ─── Props ────────────────────────────────────────────────────────

export interface BlockCopyPastePluginProps {
  /**
   * Currently selected block IDs (may include child IDs when a parent is
   * selected via keyboard selection or drag selection).
   */
  selectedBlockIds: string[];
  /**
   * Mirror of BlockPlugin's onContentChange — called when paste creates new
   * blocks so their AST is persisted to the backend immediately.
   */
  onContentChange?: (blockId: string, contentAST: ASTDocument) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** True when a block's contentAST represents an empty/whitespace-only block */
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

/**
 * Parse a BlockData.name field (stored as AST JSON) back to ASTDocument.
 * Falls back to a plain-text paragraph on parse failure.
 */
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
 * Insert a node_link pill into a block's contentAST at the given cursor offset.
 * Uses a pure runtime update — no API call required.
 *
 * @param targetUuid  UUID of the block/page being linked to
 * @param blockId     Block whose content should receive the pill
 * @param cursorOffset  Character offset where the pill should be inserted
 * @param onContentChange  Persistence callback
 */
function insertLinkPillAtOffset(
  targetUuid: string,
  blockId: string,
  cursorOffset: number,
  onContentChange?: (blockId: string, contentAST: ASTDocument) => void,
): void {
  const runtime = getNodeGraphRuntime();
  const graphNode = runtime.getNode(blockId);
  if (!graphNode) return;

  const link = nodeLink(buildLinkId(targetUuid, generateUUID()), 'node');

  const existing = graphNode.contentAST ?? [paragraph(astText(''))];
  // Flatten all inlines from the existing content (assumes single paragraph/heading)
  const existingInlines: ASTInlineNode[] = existing.flatMap(
    p => ('children' in p ? (p.children as ASTInlineNode[]) : []),
  );

  // Split existingInlines at cursorOffset
  let remaining = cursorOffset;
  let splitIdx = existingInlines.length; // default: append at end
  let splitTextOffset = 0;
  for (let i = 0; i < existingInlines.length; i++) {
    const inline = existingInlines[i];
    const len =
      inline.type === 'text' ? inline.text.length
      : inline.type === 'node_link' || inline.type === 'external_link' ? 1
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

  // Preserve block type (heading vs paragraph)
  const firstBlock = existing[0];
  const newPara: ASTDocument[number] =
    firstBlock?.type === 'heading'
      ? { type: 'heading', level: firstBlock.level ?? 1, children: [...before, link, ...after] }
      : paragraph(...before, link, ...after);

  const newAST: ASTDocument = [newPara];
  runtime.applyIntent({ type: 'update_content', blockId, contentAST: newAST });
  onContentChange?.(blockId, newAST);
  runtime.requestFocus(blockId, cursorOffset + 1);
  runtime.flushEvents();
}

/**
 * Recursively paste a tree of BlockData into the runtime.
 *
 * @param blocks        Top-level BlockData items to paste
 * @param parentId      Runtime block ID of the parent to nest under
 * @param afterBlockId  Insert after this sibling (null = prepend)
 * @param onContentChange  Persistence callback
 * @returns Array of created top-level block IDs (in insertion order)
 */
function pasteBlockTree(
  blocks: BlockData[],
  parentId: string,
  afterBlockId: string | null,
  onContentChange?: (blockId: string, contentAST: ASTDocument) => void,
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

    // Notify persistence layer
    onContentChange?.(newId, contentAST);

    lastAfter = newId;

    // Recursively paste children (nested under this new block)
    if (block.children && block.children.length > 0) {
      pasteBlockTree(block.children, newId, null, onContentChange);
    }
  }

  return createdIds;
}

/**
 * Paste a BlockCopyData snapshot after a specific block.
 * Used by context-menu "Paste" and document-level Ctrl+V in selection mode.
 *
 * @param blockData   The data to paste
 * @param afterBlockId  The sibling after which to insert top-level blocks
 * @param onContentChange  Persistence callback
 */
export function pasteBlocksAfterBlock(
  blockData: BlockCopyData,
  afterBlockId: string,
  onContentChange?: (blockId: string, contentAST: ASTDocument) => void,
): void {
  const runtime = getNodeGraphRuntime();
  const afterNode = runtime.getNode(afterBlockId);
  if (!afterNode?.parentId) return;

  const createdIds = pasteBlockTree(
    blockData.blocks,
    afterNode.parentId,
    afterBlockId,
    onContentChange,
  );

  runtime.flushEvents();
  if (createdIds.length > 0) {
    runtime.requestFocus(createdIds[createdIds.length - 1]);
    runtime.flushEvents();
  }
}

// ─── Plugin ───────────────────────────────────────────────────────

export function BlockCopyPastePlugin({
  selectedBlockIds,
  onContentChange,
}: BlockCopyPastePluginProps): null {
  const [editor] = useLexicalComposerContext();

  // Stable refs so event handlers always have the latest values
  const selectedBlockIdsRef = useRef<string[]>(selectedBlockIds);
  selectedBlockIdsRef.current = selectedBlockIds;

  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  // ── 1. COPY_COMMAND: intercept Ctrl+C in edit mode ────────────
  // Fires only when the editor has focus. If the Lexical selection is
  // collapsed (cursor, no text), copy the block link [[uuid]] and suppress
  // the browser's native copy. If text is selected, return false so the
  // browser handles it normally.
  useEffect(() => {
    return editor.registerCommand<ClipboardEvent>(
      COPY_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;

        // Text is selected → let browser copy it
        if (!selection.isCollapsed()) return false;

        // No text selected → copy the block link
        const anchorNode = selection.anchor.getNode();
        if ($isBlockNode(anchorNode)) return false; // safety guard
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return false;

        const blockId = blockNode.getBlockId();
        const linkText = `[[${blockId}]]`;

        // Write synchronously via the copy event's clipboardData — this is
        // the correct approach for copy-event handlers and avoids the async
        // race condition of navigator.clipboard.writeText().
        if (event?.clipboardData) {
          event.preventDefault();
          event.clipboardData.setData('text/plain', linkText);
        } else {
          // Fallback (e.g. Firefox) — async, but clipboard API should be
          // available in a user-gesture context.
          copyToClipboard(linkText).catch(console.error);
        }

        useClipboardStore.getState().setLinkMode();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  // ── 2. PASTE_COMMAND: handle internal-blocks or link paste in edit mode ─
  // Runs at HIGH priority so it fires before PasteBlocksPlugin (NORMAL).
  useEffect(() => {
    return editor.registerCommand<ClipboardEvent>(
      PASTE_COMMAND,
      (event) => {
        const clipboardData = event?.clipboardData;
        if (!clipboardData) return false;

        const text = clipboardData.getData('text/plain');
        if (!text) return false;

        // ── Link-mode paste: insert inline link pill at cursor ────────────
        // When mode is 'link' (set by our COPY_COMMAND handler when no text
        // was selected), the clipboard has [[uuid]]. Resolve via the runtime
        // directly — no async API call, works for unsaved/optimistic blocks.
        const { mode: clipMode } = useClipboardStore.getState();
        if (clipMode === 'link') {
          const uuidMatch = text.match(/^\[\[([0-9a-f-]{36})\]\]$/i);
          if (uuidMatch) {
            const targetUuid = uuidMatch[1];
            let currentBlockId: string | null = null;
            let cursorOffset = 0;
            const pasteSelection = $getSelection();
            if ($isRangeSelection(pasteSelection)) {
              const blockNode = findParentNodeBlock(pasteSelection.anchor.getNode());
              if (blockNode) {
                currentBlockId = blockNode.getBlockId();
                // Compute cursor offset (mirrors BlockPlugin / PasteBlocksPlugin logic)
                for (const child of blockNode.getChildren()) {
                  if (
                    child === pasteSelection.anchor.getNode() ||
                    child.getKey() === pasteSelection.anchor.key
                  ) break;
                  if ($isTextNode(child)) {
                    const t = child.getTextContent();
                    if (t !== '\u200B') cursorOffset += t.length;
                  } else if ($isInlineLinkNode(child)) {
                    cursorOffset += 1;
                  }
                }
                const anchorNode = pasteSelection.anchor.getNode();
                if ($isTextNode(anchorNode)) cursorOffset += pasteSelection.anchor.offset;
              }
            }
            if (currentBlockId) {
              event.preventDefault();
              insertLinkPillAtOffset(
                targetUuid,
                currentBlockId,
                cursorOffset,
                onContentChangeRef.current,
              );
              return true;
            }
          }
        }

        // ── Internal-blocks paste: structured block copy/paste ────────────
        const blockData = tryParseInternalFormat(text);
        if (!blockData || blockData.blocks.length === 0) return false;

        // Determine the block the cursor is in
        let currentBlockId: string | null = null;
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          const blockNode = findParentNodeBlock(selection.anchor.getNode());
          if (blockNode) currentBlockId = blockNode.getBlockId();
        }
        if (!currentBlockId) return false;

        const runtime = getNodeGraphRuntime();
        const currentNode = runtime.getNode(currentBlockId);
        if (!currentNode?.parentId) return false;

        event.preventDefault();

        const ocRef = onContentChangeRef.current;
        const parentId = currentNode.parentId;

        if (isBlockEmpty(currentNode.contentAST)) {
          // ── Empty block: replace its content with the first pasted block,
          //    then paste the rest as siblings after it.
          const [firstBlock, ...restBlocks] = blockData.blocks;
          const firstAST = parseBlockName(firstBlock.name);

          runtime.applyIntent({
            type: 'update_content',
            blockId: currentBlockId,
            contentAST: firstAST,
          });
          ocRef?.(currentBlockId, firstAST);

          // Children of the first pasted block become children of current block
          if (firstBlock.children && firstBlock.children.length > 0) {
            pasteBlockTree(firstBlock.children, currentBlockId, null, ocRef);
          }

          // Remaining top-level blocks go after current block
          if (restBlocks.length > 0) {
            const created = pasteBlockTree(restBlocks, parentId, currentBlockId, ocRef);
            runtime.flushEvents();
            if (created.length > 0) {
              runtime.requestFocus(created[created.length - 1]);
            }
          } else {
            runtime.flushEvents();
            runtime.requestFocus(currentBlockId);
          }
        } else {
          // ── Non-empty block: paste all blocks as siblings after current block
          const created = pasteBlockTree(blockData.blocks, parentId, currentBlockId, ocRef);
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
  }, [editor]);

  // ── 3. Document-level Ctrl+C: copy selected blocks ────────────
  // The editor is blurred when blocks are selected (keyboard/drag selection
  // mode), so COPY_COMMAND won't fire. We intercept at the document level.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const isCtrlC =
        (isMac ? event.metaKey : event.ctrlKey) &&
        event.key.toLowerCase() === 'c' &&
        !event.shiftKey &&
        !event.altKey;

      if (!isCtrlC) return;

      // Only intercept when the editor is NOT focused (block selection mode)
      const rootEl = editor.getRootElement();
      if (rootEl?.contains(document.activeElement)) return;

      // Don't copy blocks while a dialog/menu is open
      if (document.activeElement?.closest('[role="dialog"]') || document.activeElement?.closest('[role="menu"]')) return;

      const ids = selectedBlockIdsRef.current;
      if (ids.length === 0) return;

      event.preventDefault();

      const runtime = getNodeGraphRuntime();
      copyRuntimeBlocksToClipboard(ids, runtime)
        .then((data) => useClipboardStore.getState().setCopied(data))
        .catch(console.error);
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [editor]);

  // ── 4. Document-level Ctrl+V: paste after selected block ──────
  // When in block-selection mode (editor blurred), Ctrl+V pastes the
  // clipboard content after the last top-level selected block.
  // We read from the in-memory clipboardStore first (sync) and fall back
  // to the system clipboard for cross-session paste support.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const isCtrlV =
        (isMac ? event.metaKey : event.ctrlKey) &&
        event.key.toLowerCase() === 'v' &&
        !event.shiftKey &&
        !event.altKey;

      if (!isCtrlV) return;

      // Only intercept when editor is NOT focused
      const rootEl = editor.getRootElement();
      if (rootEl?.contains(document.activeElement)) return;

      const ids = selectedBlockIdsRef.current;
      if (ids.length === 0) return;

      // Determine the last top-level selected block
      const runtime = getNodeGraphRuntime();
      const blockIdSet = new Set(ids);
      const topLevelIds = ids.filter(id => {
        const n = runtime.getNode(id);
        return n && (!n.parentId || !blockIdSet.has(n.parentId));
      });
      if (topLevelIds.length === 0) return;
      const lastTopLevelId = topLevelIds[topLevelIds.length - 1];

      // Try in-memory store first (sync path)
      const { mode, copiedBlocks } = useClipboardStore.getState();
      if (mode === 'blocks' && copiedBlocks) {
        event.preventDefault();
        pasteBlocksAfterBlock(copiedBlocks, lastTopLevelId, onContentChangeRef.current);
        return;
      }

      // Async fallback: read system clipboard (requires user-gesture permission)
      event.preventDefault();
      navigator.clipboard
        .readText()
        .then((text) => {
          const blockData = tryParseInternalFormat(text);
          if (blockData) {
            pasteBlocksAfterBlock(blockData, lastTopLevelId, onContentChangeRef.current);
          }
        })
        .catch(() => {
          // Clipboard access denied — silently ignore
        });
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [editor]);

  return null;
}
