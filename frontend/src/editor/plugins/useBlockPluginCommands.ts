/**
 * Custom hook containing all keyboard command handlers for the BlockPlugin.
 */

import { useEffect, useCallback } from 'react';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $createTextNode,
  $createNodeSelection,
  $setSelection,
  $isTextNode,
  $isLineBreakNode,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_NORMAL,
  KEY_ENTER_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_TAB_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  MOVE_TO_START,
  MOVE_TO_END,
  $createLineBreakNode,
  type LexicalEditor,
} from 'lexical';
import { $isBlockNode } from '@/editor/nodes/BlockNode';
import { $isInlineLinkNode } from '@/editor/nodes/InlineLinkNode';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { findParentNodeBlock } from '@/editor/utils/selectionUtils';
import { generateUUID } from '@/utils/uuid';

export interface UseBlockPluginCommandsProps {
  editor: LexicalEditor;
  readOnly: boolean;
  includeRoot?: boolean;
  rootBlockId?: string;
  onEnterAtRoot?: () => void;
  onBlockMerge?: (sourceBlockId: string, targetBlockId: string) => void;
  onBlockDelete?: (blockId: string) => void;
  onIndent?: (blockId: string) => void;
  onOutdent?: (blockId: string) => void;
  onMoveUp?: (blockId: string) => void;
  onMoveDown?: (blockId: string) => void;
  onNavigateUpFromTop?: () => void;
}

export function useBlockPluginCommands(props: UseBlockPluginCommandsProps): void {
  const {
    editor,
    readOnly,
    includeRoot,
    rootBlockId,
    onEnterAtRoot,
    onBlockMerge,
    onBlockDelete,
    onIndent,
    onOutdent,
    onMoveUp,
    onMoveDown,
    onNavigateUpFromTop,
  } = props;

  // ─── Enter: split block ────────────────────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        // Shift+Enter: insert soft line break within the block
        if (event?.shiftKey) {
          event.preventDefault();
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;
            selection.insertNodes([$createLineBreakNode()]);
          });
          return true;
        }

        // Command handlers run inside a Lexical state context —
        // call $getSelection() directly (NOT inside editor.read()).
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;

        const anchorNode = selection.anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return false;

        // Code block: Enter inserts a line break (no new block).
        // We mutate directly because command handlers already run
        // inside editor.update() from Lexical's keydown handler.
        // A trailing ZWS TextNode is added so the cursor has a valid
        // DOM anchor after the <br> (prevents custom caret mis-positioning).
        if (blockNode.getNodeType() === 'code') {
          event?.preventDefault();
          const lb = $createLineBreakNode();
          selection.insertNodes([lb]);
          // Ensure cursor sits on a TextNode, not after a bare <br>
          const next = lb.getNextSibling();
          if (!next || !$isTextNode(next) || next.getTextContent() === '') {
            const zwsAnchor = $createTextNode('\u200B');
            lb.insertAfter(zwsAnchor);
            zwsAnchor.select(1, 1);
          }
          return true;
        }

        const blockId = blockNode.getBlockId();

        // Calculate cursor offset by walking through block children.
        // ZWS-only TextNodes are skipped because extractBlockContent strips
        // them from the runtime's contentAST — offsets must stay aligned.
        let cursorOffset = 0;
        const children = blockNode.getChildren();
        for (const child of children) {
          if (child === anchorNode || child.getKey() === anchorNode.getKey()) {
            // If the anchor is a ZWS placeholder, it doesn't exist in the
            // runtime AST so its offset contributes nothing.
            if (!($isTextNode(child) && child.getTextContent() === '\u200B')) {
              cursorOffset += selection.anchor.offset;
            }
            break;
          }
          if ($isTextNode(child)) {
            const text = child.getTextContent();
            // Skip ZWS-only nodes (they're stripped in extractBlockContent)
            if (text !== '\u200B') {
              cursorOffset += text.length;
            }
          } else if ($isInlineLinkNode(child)) {
            cursorOffset += 1; // Pills count as 1 character
          } else {
            cursorOffset += child.getTextContent().length;
          }
        }

        event?.preventDefault();

        const runtime = getNodeGraphRuntime();
        const newBlockId = generateUUID();

        // Special case: Enter at offset 0 should create a new empty block BEFORE current
        // (keeping current block unchanged with its UUID, content, links, etc.)
        if (cursorOffset === 0 && !(includeRoot && blockId === rootBlockId)) {
          const currentNode = runtime.getNode(blockId);
          if (currentNode && currentNode.parentId) {
            const siblings = runtime.getChildren(currentNode.parentId);
            const currentIndex = siblings.findIndex(s => s.blockId === blockId);
            const prevSiblingId = currentIndex > 0 ? siblings[currentIndex - 1].blockId : null;

            // Create empty block before current
            runtime.applyIntent({
              type: 'create_block',
              parentId: currentNode.parentId,
              afterBlockId: prevSiblingId,
              blockId: newBlockId,
              contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
            });

            // Focus the new empty block
            runtime.requestFocus(newBlockId);
            runtime.flushEvents();
            return true;
          }
        }

        // Normal case: split block or create child
        runtime.requestFocus(newBlockId);

        if (includeRoot && blockId === rootBlockId) {
          if (onEnterAtRoot) {
            // Delegate to external handler (e.g., multi-text property adds sibling entry)
            onEnterAtRoot();
            return true;
          }
          // Projection root: create a new first child instead of splitting
          // (splitting would create a sibling outside the projection)
          runtime.applyIntent({
            type: 'create_block',
            parentId: blockId,
            afterBlockId: null, // first child
            blockId: newBlockId,
            contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
          });
        } else {
          // Normal block: split content at cursor position
          runtime.applyIntent({
            type: 'split_block',
            blockId,
            atOffset: cursorOffset,
            newBlockId,
          });
        }
        // Flush runtime events immediately so the new block is synced
        // and focused in the same frame as the Enter keypress
        runtime.flushEvents();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, includeRoot, rootBlockId, onEnterAtRoot]);

  // ─── Merge guard: check hierarchy constraints ────────────
  //
  // A merge is only allowed when the source block (the one being deleted):
  //   1. Is a sibling of the target block AND has no children, OR
  //   2. Is the only child of the target block
  //
  // This prevents accidentally merging blocks that would lose hierarchy.

  const canMergeInHierarchy = useCallback((sourceBlockId: string, targetBlockId: string): boolean => {
    const runtime = getNodeGraphRuntime();
    const source = runtime.getNode(sourceBlockId);
    const target = runtime.getNode(targetBlockId);
    if (!source || !target) return false;

    const sourceChildren = runtime.getChildren(sourceBlockId);

    // Case 1: source is sibling of target (same parent) and has no children
    if (source.parentId === target.parentId && sourceChildren.length === 0) {
      return true;
    }

    // Case 2: source is the only child of target
    if (source.parentId === targetBlockId) {
      const targetChildren = runtime.getChildren(targetBlockId);
      if (targetChildren.length === 1) {
        return true;
      }
    }

    return false;
  }, []);

  // ─── Backspace at start: merge with previous ──────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        // Command handlers run inside a Lexical state context —
        // call $getSelection() directly (NOT inside editor.read()).
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;
        if (!selection.isCollapsed()) return false;

        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return false;

        // Code block: handle backspace ourselves to avoid native <br> weirdness.
        // - Non-empty / has line breaks → explicitly delete char/selection,
        //   preventing the browser from interfering with the LineBreakNode DOM.
        // - Completely empty block → fall through to the normal block-delete path.
        if (blockNode.getNodeType() === 'code') {
          const hasLineBreaks = blockNode.getChildren().some($isLineBreakNode);
          const textContent = blockNode.getTextContent().replace(/\u200B/g, '');
          const isEmptyBlock = !hasLineBreaks && textContent === '';

          if (!isEmptyBlock) {
            // If cursor is at the absolute start of the code block, do nothing
            // (avoids accidentally deleting into the previous block)
            const atBlockStart =
              anchor.offset === 0 &&
              (anchor.type !== 'text' || anchorNode === blockNode.getFirstDescendant());
            if (atBlockStart) return true; // consume but do nothing

            event?.preventDefault();
            // Direct mutation — no editor.update() wrapper needed,
            // we're already inside one from the keydown handler.
            selection.deleteCharacter(true);
            return true;
          }
          // Fall through → delete the empty code block via normal path below
        }

        // Check if block is effectively empty (only contains zero-width space or empty).
        // DecoratorNodes like InlineLinkNode return '' from getTextContent(), so a block
        // containing only inline links would appear empty by text alone — check for them too.
        const textContent = blockNode.getTextContent();
        const hasInlineLinks = blockNode.getChildren().some(child => $isInlineLinkNode(child));
        const isEmptyBlock = (textContent === '' || textContent === '\u200B') && !hasInlineLinks;

        // A block that has inline links but no meaningful text (only ZWS placeholders).
        // These should NOT be merged/deleted — backspace selects the link first.
        const textWithoutZWS = textContent.replace(/\u200B/g, '');
        const isLinkOnlyBlock = hasInlineLinks && textWithoutZWS === '';

        // Only merge/delete when cursor is at the absolute start of the block
        if (!isEmptyBlock) {
          if (anchor.offset !== 0) return false;
          // For text anchors: must be the deepest-first node of the block
          // For element anchors: must be the block itself at child index 0
          if (anchor.type === 'text') {
            if (anchorNode !== blockNode.getFirstDescendant()) return false;
          } else {
            if (anchorNode !== blockNode) return false;
          }
        }

        // Inline-link-only block: select the link instead of merging/deleting.
        // This way backspace transitions link → selected-link → removed-link → empty-block → delete.
        if (isLinkOnlyBlock) {
          const linkChild = blockNode.getChildren().find(child => $isInlineLinkNode(child));
          if (linkChild) {
            event?.preventDefault();
            const sel = $createNodeSelection();
            sel.add(linkChild.getKey());
            $setSelection(sel);
            return true;
          }
        }

        const root = $getRoot();
        const children = root.getChildren();
        const blockIndex = children.indexOf(blockNode);

        // Handle first block specially
        if (blockIndex === 0) {
          if (isEmptyBlock) {
            event?.preventDefault();
            onBlockDelete?.(blockNode.getBlockId());
            return true;
          }
          // At start of non-empty first block - can't merge
          return false;
        }

        if (blockIndex < 0) return false;

        const prevBlock = children[blockIndex - 1];
        if ($isBlockNode(prevBlock)) {
          const sourceId = blockNode.getBlockId();
          const targetId = prevBlock.getBlockId();
          if (!canMergeInHierarchy(sourceId, targetId)) {
            event?.preventDefault();
            return true;
          }
          event?.preventDefault();
          onBlockMerge?.(sourceId, targetId);
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, onBlockMerge, onBlockDelete, canMergeInHierarchy]);

  // ─── Delete at end: merge with next ───────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_DELETE_COMMAND,
      (event) => {
        // Command handlers run inside a Lexical state context —
        // call $getSelection() directly (NOT inside editor.read()).
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;
        if (!selection.isCollapsed()) return false;

        const anchorNode = selection.anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return false;

        // Check if cursor is at the absolute end of the block
        const anchor = selection.anchor;
        if (anchor.type === 'text') {
          const lastDescendant = blockNode.getLastDescendant();
          if (anchorNode !== lastDescendant || anchor.offset < anchorNode.getTextContentSize()) return false;
        } else {
          if (anchorNode !== blockNode || anchor.offset < blockNode.getChildrenSize()) return false;
        }

        const root = $getRoot();
        const children = root.getChildren();
        const blockIndex = children.indexOf(blockNode);
        if (blockIndex >= children.length - 1) return false;

        const nextBlock = children[blockIndex + 1];
        if ($isBlockNode(nextBlock)) {
          const sourceId = nextBlock.getBlockId();
          const targetId = blockNode.getBlockId();
          if (!canMergeInHierarchy(sourceId, targetId)) {
            event?.preventDefault();
            return true;
          }
          event?.preventDefault();
          onBlockMerge?.(sourceId, targetId);
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, onBlockMerge, canMergeInHierarchy]);

  // ─── Tab/Shift+Tab: indent/outdent ────────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        // Command handlers run inside a Lexical state context —
        // call $getSelection() directly (NOT inside editor.read()).
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;

        const anchorNode = selection.anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return false;

        const blockIdToIndent = blockNode.getBlockId();
        const shouldOutdent = event?.shiftKey ?? false;

        event?.preventDefault();

        if (shouldOutdent) {
          onOutdent?.(blockIdToIndent);
        } else {
          onIndent?.(blockIdToIndent);
        }

        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, onIndent, onOutdent]);

  // ─── Alt+Shift+Up/Down: move block up/down ────────────────

  useEffect(() => {
    if (readOnly) return;

    const handleMoveUpKey = (event: KeyboardEvent) => {
      // Only handle Alt+Shift+ArrowUp
      if (!event.altKey || !event.shiftKey) return false;

      // Command handlers run inside a Lexical state context —
      // call $getSelection() directly (NOT inside editor.read()).
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;

      const anchorNode = selection.anchor.getNode();
      const blockNode = findParentNodeBlock(anchorNode);
      if (!blockNode) return false;

      const blockId = blockNode.getBlockId();
      event.preventDefault();
      onMoveUp?.(blockId);
      return true;
    };

    const handleMoveDownKey = (event: KeyboardEvent) => {
      // Only handle Alt+Shift+ArrowDown
      if (!event.altKey || !event.shiftKey) return false;

      // Command handlers run inside a Lexical state context —
      // call $getSelection() directly (NOT inside editor.read()).
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;

      const anchorNode = selection.anchor.getNode();
      const blockNode = findParentNodeBlock(anchorNode);
      if (!blockNode) return false;

      const blockId = blockNode.getBlockId();
      event.preventDefault();
      onMoveDown?.(blockId);
      return true;
    };

    const unsubUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      handleMoveUpKey,
      COMMAND_PRIORITY_HIGH
    );
    const unsubDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      handleMoveDownKey,
      COMMAND_PRIORITY_HIGH
    );

    return () => {
      unsubUp();
      unsubDown();
    };
  }, [editor, readOnly, onMoveUp, onMoveDown]);

  // ─── Left/Right: navigate between blocks ──────────────────

  useEffect(() => {
    if (readOnly) return;

    const handleArrowLeft = (event: KeyboardEvent | null) => {
      // Command handlers run inside a Lexical state context —
      // call $getSelection() directly (NOT inside editor.read()).
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      if (!selection.isCollapsed()) return false;

      const anchor = selection.anchor;
      const anchorNode = anchor.getNode();
      const blockNode = findParentNodeBlock(anchorNode);
      if (!blockNode) return false;

      // ── Style-boundary guard ──────────────────────────────────────
      // If cursor is at the START of a styled text node that is the first
      // content in its block AND Lexical's carry-over format is non-zero,
      // clear it (first press = exit style context). Second press navigates.
      // Also fires when all siblings before the anchor are whitespace-only
      // (e.g. a leading space node that would otherwise break the check).
      const isEffectivelyFirst = (): boolean => {
        let sib = anchorNode.getPreviousSibling();
        while (sib) {
          if (!$isTextNode(sib) || sib.getTextContent().trim() !== '') return false;
          sib = sib.getPreviousSibling();
        }
        return true;
      };
      if (
        $isTextNode(anchorNode) &&
        selection.format !== 0 &&
        anchor.offset === 0 &&
        isEffectivelyFirst()
      ) {
        event?.preventDefault();
        selection.format = 0;
        return true;
      }

      // Must be at the absolute start of the block (whitespace-only preceding siblings are ignored)
      if (anchor.offset !== 0) return false;
      if (anchor.type === 'text' && !isEffectivelyFirst()) return false;

      const root = $getRoot();
      const children = root.getChildren();
      const blockIndex = children.indexOf(blockNode);
      if (blockIndex <= 0) return false;

      const prevBlock = children[blockIndex - 1];
      if (!$isBlockNode(prevBlock)) return false;

      event?.preventDefault();
      editor.update(() => {
        const lastChild = prevBlock.getLastDescendant();
        if (lastChild) {
          lastChild.selectEnd();
        }
      });

      return true;
    };

    const handleArrowRight = (event: KeyboardEvent | null) => {
      // Command handlers run inside a Lexical state context —
      // call $getSelection() directly (NOT inside editor.read()).
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      if (!selection.isCollapsed()) return false;

      const anchor = selection.anchor;
      const anchorNode = anchor.getNode();
      const blockNode = findParentNodeBlock(anchorNode);
      if (!blockNode) return false;

      // ── Style-boundary guard ──────────────────────────────────────
      // If cursor is at the END of a styled text node that is the last
      // content in its block AND Lexical's carry-over format is non-zero,
      // clear it (first press = exit style context). Second press navigates.
      // Also fires when all siblings after the anchor are whitespace-only
      // (e.g. a trailing space node that would otherwise break the check).
      const isEffectivelyLast = (): boolean => {
        let sib = anchorNode.getNextSibling();
        while (sib) {
          if (!$isTextNode(sib) || sib.getTextContent().trim() !== '') return false;
          sib = sib.getNextSibling();
        }
        return true;
      };
      if (
        $isTextNode(anchorNode) &&
        selection.format !== 0 &&
        anchor.offset === anchorNode.getTextContentSize() &&
        isEffectivelyLast()
      ) {
        event?.preventDefault();
        selection.format = 0;
        return true;
      }

      // Must be at the absolute end of the block
      if (anchor.type === 'text') {
        // Whitespace-only trailing siblings are ignored (e.g. a trailing space node)
        if (!isEffectivelyLast() || anchor.offset < anchorNode.getTextContentSize()) return false;
      } else {
        if (anchorNode !== blockNode || anchor.offset < blockNode.getChildrenSize()) return false;
      }

      const root = $getRoot();
      const children = root.getChildren();
      const blockIndex = children.indexOf(blockNode);
      if (blockIndex >= children.length - 1) return false;

      const nextBlock = children[blockIndex + 1];
      if (!$isBlockNode(nextBlock)) return false;

      event?.preventDefault();
      editor.update(() => {
        const firstChild = nextBlock.getFirstDescendant();
        if (firstChild) {
          firstChild.selectStart();
        }
      });

      return true;
    };

    const unsubLeft = editor.registerCommand(KEY_ARROW_LEFT_COMMAND, handleArrowLeft, COMMAND_PRIORITY_NORMAL);
    const unsubRight = editor.registerCommand(KEY_ARROW_RIGHT_COMMAND, handleArrowRight, COMMAND_PRIORITY_NORMAL);

    return () => {
      unsubLeft();
      unsubRight();
    };
  }, [editor, readOnly]);

  // ─── Up/Down: navigate vertically across all blocks ───────

  useEffect(() => {
    const handleArrowUp = () => {
      // Command handlers run inside a Lexical state context —
      // call $getSelection() directly (NOT inside editor.read()).
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;

      const anchorNode = selection.anchor.getNode();
      const blockNode = findParentNodeBlock(anchorNode);
      if (!blockNode) return false;

      const root = $getRoot();
      const children = root.getChildren();
      const blockIndex = children.indexOf(blockNode);

      // Block arrow up on first block to prevent cursor from entering empty root space.
      // Always consume the event; optionally notify parent for sidebar navigation.
      if (blockIndex <= 0) {
        onNavigateUpFromTop?.();
        return true;
      }

      // Let default arrow behavior handle vertical movement
      return false;
    };

    const handleArrowDown = () => {
      // Command handlers run inside a Lexical state context —
      // call $getSelection() directly (NOT inside editor.read()).
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;

      const anchorNode = selection.anchor.getNode();
      const blockNode = findParentNodeBlock(anchorNode);
      if (!blockNode) return false;

      const root = $getRoot();
      const children = root.getChildren();
      const blockIndex = children.indexOf(blockNode);

      // Block arrow down on last block to prevent cursor from entering empty root space.
      if (blockIndex >= children.length - 1) return true;

      // Let default arrow behavior handle vertical movement
      return false;
    };

    const unsubUp = editor.registerCommand(KEY_ARROW_UP_COMMAND, handleArrowUp, COMMAND_PRIORITY_NORMAL);
    const unsubDown = editor.registerCommand(KEY_ARROW_DOWN_COMMAND, handleArrowDown, COMMAND_PRIORITY_NORMAL);

    return () => {
      unsubUp();
      unsubDown();
    };
  }, [editor, onNavigateUpFromTop]);

  // ─── Home/End: navigate to first/last block ───────────────────

  useEffect(() => {
    const handleMoveToStart = (event: KeyboardEvent) => {
      // Command handlers run inside a Lexical state context —
      // call $getSelection() directly (NOT inside editor.read()).
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      if (!selection.isCollapsed()) return false;

      const anchor = selection.anchor;
      const anchorNode = anchor.getNode();
      const blockNode = findParentNodeBlock(anchorNode);
      if (!blockNode) return false;

      // Check if cursor is at the start of the block
      const isAtBlockStart = (() => {
        if (anchor.type === 'text') {
          const firstDescendant = blockNode.getFirstDescendant();
          return anchorNode === firstDescendant && anchor.offset === 0;
        } else {
          return anchorNode === blockNode && anchor.offset === 0;
        }
      })();

      // If not at start of current block, let default behavior move to start of current block
      if (!isAtBlockStart) return false;

      // If already at start of current block, jump to first block
      const root = $getRoot();
      const children = root.getChildren();
      if (children.length === 0) return false;

      const firstBlock = children[0];
      if (!$isBlockNode(firstBlock)) return false;
      if (firstBlock === blockNode) return true; // Already at first block

      event.preventDefault();
      editor.update(() => {
        const firstChild = firstBlock.getFirstDescendant();
        if (firstChild) {
          firstChild.selectStart();
        }
      });

      return true;
    };

    const handleMoveToEnd = (event: KeyboardEvent) => {
      // Command handlers run inside a Lexical state context —
      // call $getSelection() directly (NOT inside editor.read()).
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      if (!selection.isCollapsed()) return false;

      const anchor = selection.anchor;
      const anchorNode = anchor.getNode();
      const blockNode = findParentNodeBlock(anchorNode);
      if (!blockNode) return false;

      // Check if cursor is at the end of the block
      const isAtBlockEnd = (() => {
        if (anchor.type === 'text') {
          const lastDescendant = blockNode.getLastDescendant();
          return anchorNode === lastDescendant && anchor.offset >= anchorNode.getTextContentSize();
        } else {
          return anchorNode === blockNode && anchor.offset >= blockNode.getChildrenSize();
        }
      })();

      // If not at end of current block, let default behavior move to end of current block
      if (!isAtBlockEnd) return false;

      // If already at end of current block, jump to last block
      const root = $getRoot();
      const children = root.getChildren();
      if (children.length === 0) return false;

      const lastBlock = children[children.length - 1];
      if (!$isBlockNode(lastBlock)) return false;
      if (lastBlock === blockNode) return true; // Already at last block

      event.preventDefault();
      editor.update(() => {
        const lastChild = lastBlock.getLastDescendant();
        if (lastChild) {
          lastChild.selectEnd();
        }
      });

      return true;
    };

    const unsubHome = editor.registerCommand(MOVE_TO_START, handleMoveToStart, COMMAND_PRIORITY_NORMAL);
    const unsubEnd = editor.registerCommand(MOVE_TO_END, handleMoveToEnd, COMMAND_PRIORITY_NORMAL);

    return () => {
      unsubHome();
      unsubEnd();
    };
  }, [editor]);
}
