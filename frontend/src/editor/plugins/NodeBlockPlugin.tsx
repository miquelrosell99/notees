/**
 * NodeBlockPlugin — Lexical plugin that manages NodeBlockNode lifecycle.
 *
 * Connects the Lexical editor to the NodeGraphRuntime projection.
 * Handles:
 * - Syncing projected nodes into the Lexical tree
 * - Translating Lexical text changes back to runtime content updates
 * - Enter/Backspace/Delete behavior for block creation/merging
 * - Tab/Shift+Tab for indent/outdent via runtime intents
 */

import { useEffect, useCallback, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $createTextNode,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_NORMAL,
  KEY_ENTER_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_TAB_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ESCAPE_COMMAND,
} from 'lexical';

import {
  $createNodeBlockNode,
  $isNodeBlockNode,
  NodeBlockNode,
} from '../nodes/NodeBlockNode';
import { $createNodePillNode, $isNodePillNode } from '../nodes/NodePillNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { findParentNodeBlock } from '../utils/selectionUtils';
import type { ProjectedNode, ContentAST } from '../../runtime/types';
import type { ASTInlineNode } from '@/types/ast';

// ─── Props ────────────────────────────────────────────────────────

export interface NodeBlockPluginProps {
  /** The editor instance ID */
  editorId: string;
  /** The root blockId to project from */
  rootBlockId: string;
  /** Called when a block's content changes */
  onContentChange?: (blockId: string, contentAST: ContentAST) => void;
  /** Called when a new block should be created */
  onBlockCreate?: (parentId: string, afterBlockId: string, newBlockId: string) => void;
  /** Called when blocks should be merged */
  onBlockMerge?: (sourceBlockId: string, targetBlockId: string) => void;
  /** Called for indent/outdent */
  onIndent?: (blockId: string) => void;
  onOutdent?: (blockId: string) => void;
  /** Called on escape */
  onEscape?: () => void;
  /** Read-only mode */
  readOnly?: boolean;
  /** Whether to include the root block itself in projection (default: false) */
  includeRoot?: boolean;
  /** Maximum depth to project (-1 = unlimited, default: -1) */
  maxDepth?: number;
}

// ─── Plugin component ─────────────────────────────────────────────

export function NodeBlockPlugin({
  editorId,
  rootBlockId,
  onContentChange,
  onBlockCreate,
  onBlockMerge,
  onIndent,
  onOutdent,
  onEscape,
  readOnly = false,
  includeRoot = false,
  maxDepth = -1,
}: NodeBlockPluginProps): null {
  const [editor] = useLexicalComposerContext();
  const blockIdToKeyMap = useRef(new Map<string, string>());

  // ─── Sync projected nodes into Lexical ──────────────────────

  const syncProjection = useCallback((projectedNodes: ProjectedNode[]) => {
    editor.update(() => {
      const root = $getRoot();
      const existingNodes = root.getChildren();
      const existingBlockMap = new Map<string, NodeBlockNode>();

      for (const child of existingNodes) {
        if ($isNodeBlockNode(child)) {
          existingBlockMap.set(child.getBlockId(), child);
        }
      }

      const newBlockIds = new Set(projectedNodes.filter(n => n.visible).map(n => n.blockId));

      // Remove nodes no longer in projection
      for (const [blockId, node] of existingBlockMap) {
        if (!newBlockIds.has(blockId)) {
          node.remove();
          blockIdToKeyMap.current.delete(blockId);
        }
      }

      // Insert/update nodes
      const visibleNodes = projectedNodes.filter(n => n.visible);
      for (let i = 0; i < visibleNodes.length; i++) {
        const projected = visibleNodes[i];
        const existing = existingBlockMap.get(projected.blockId);

        if (existing) {
          // Update existing node
          existing.setDepth(projected.depth);
          existing.setCollapsed(projected.collapsed);
          existing.setHasChildren(projected.hasChildren);
          existing.setIcon(projected.icon ?? null);
          existing.setColor(projected.color ?? null);
          existing.setBlockName(projected.name ?? '');
        } else {
          // Create new node
          const newBlock = $createNodeBlockNode(
            projected.blockId,
            projected.depth,
            projected.collapsed,
            projected.nodeType,
            projected.hasChildren,
            projected.icon ?? null,
            projected.color ?? null,
            projected.name ?? '',
          );

          // Populate inline content from contentAST
          populateBlockContent(newBlock, projected.contentAST);

          // Insert at correct position
          const children = root.getChildren();
          if (i < children.length) {
            children[i].insertBefore(newBlock);
          } else {
            root.append(newBlock);
          }

          blockIdToKeyMap.current.set(projected.blockId, newBlock.getKey());
        }
      }
    });
  }, [editor]);

  // ─── Subscribe to runtime events ───────────────────────────

  useEffect(() => {
    const runtime = getNodeGraphRuntime();

    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'nodes_changed' || event.type === 'structure_changed') {
        const projection = runtime.project({
          projectionId: editorId,
          rootBlockId,
          maxDepth,
          includeRoot,
        });
        syncProjection(projection);
      }
    });

    // Initial sync
    const initialProjection = runtime.project({
      projectionId: editorId,
      rootBlockId,
      maxDepth,
      includeRoot,
    });
    syncProjection(initialProjection);

    return unsubscribe;
  }, [editor, editorId, rootBlockId, syncProjection]);

  // ─── Text change listener ──────────────────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerUpdateListener(({ editorState, dirtyElements }) => {
      if (dirtyElements.size === 0) return;

      editorState.read(() => {
        const root = $getRoot();
        for (const child of root.getChildren()) {
          if ($isNodeBlockNode(child) && dirtyElements.has(child.getKey())) {
            const blockId = child.getBlockId();
            const contentAST = extractBlockContent(child);
            onContentChange?.(blockId, contentAST);
          }
        }
      });
    });
  }, [editor, readOnly, onContentChange]);

  // ─── Enter: split block ────────────────────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        let blockId: string | null = null;

        editor.read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;

          const anchorNode = selection.anchor.getNode();
          const blockNode = findParentNodeBlock(anchorNode);
          if (!blockNode) return;

          blockId = blockNode.getBlockId();
        });

        if (!blockId) return false;

        event?.preventDefault();

        const newBlockId = crypto.randomUUID();
        onBlockCreate?.(blockId, blockId, newBlockId);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, onBlockCreate]);

  // ─── Backspace at start: merge with previous ──────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        let currentBlockId: string | null = null;
        let prevBlockId: string | null = null;

        editor.read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          if (!selection.isCollapsed()) return;

          const anchor = selection.anchor;
          const anchorNode = anchor.getNode();
          const blockNode = findParentNodeBlock(anchorNode);
          if (!blockNode) return;

          // Check if block is effectively empty (only contains zero-width space or empty)
          const textContent = blockNode.getTextContent();
          const isEmptyBlock = textContent === '' || textContent === '\u200B';
          
          // Allow backspace at start OR if block is empty
          if (anchor.offset !== 0 && !isEmptyBlock) return;

          // Check if cursor is at the very start of the block (or block is empty)
          const firstChild = blockNode.getFirstChild();
          if (!isEmptyBlock && anchorNode !== firstChild && anchorNode.getParent() !== blockNode) return;

          const root = $getRoot();
          const children = root.getChildren();
          const blockIndex = children.indexOf(blockNode);
          if (blockIndex <= 0) return;

          const prevBlock = children[blockIndex - 1];
          if ($isNodeBlockNode(prevBlock)) {
            currentBlockId = blockNode.getBlockId();
            prevBlockId = prevBlock.getBlockId();
          }
        });

        if (!currentBlockId || !prevBlockId) return false;

        event?.preventDefault();
        onBlockMerge?.(currentBlockId, prevBlockId);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, onBlockMerge]);

  // ─── Delete at end: merge with next ───────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_DELETE_COMMAND,
      (event) => {
        let currentBlockId: string | null = null;
        let nextBlockId: string | null = null;

        editor.read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          if (!selection.isCollapsed()) return;

          const anchorNode = selection.anchor.getNode();
          const blockNode = findParentNodeBlock(anchorNode);
          if (!blockNode) return;

          // Check if at end of block
          const textContent = blockNode.getTextContent();
          const anchor = selection.anchor;
          if (anchor.offset < textContent.length) return;

          const root = $getRoot();
          const children = root.getChildren();
          const blockIndex = children.indexOf(blockNode);
          if (blockIndex >= children.length - 1) return;

          const nextBlock = children[blockIndex + 1];
          if ($isNodeBlockNode(nextBlock)) {
            currentBlockId = blockNode.getBlockId();
            nextBlockId = nextBlock.getBlockId();
          }
        });

        if (!nextBlockId || !currentBlockId) return false;

        event?.preventDefault();
        onBlockMerge?.(nextBlockId, currentBlockId);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, onBlockMerge]);

  // ─── Tab/Shift+Tab: indent/outdent ────────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        let blockIdToIndent: string | null = null;
        let shouldOutdent = false;

        editor.read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;

          const anchorNode = selection.anchor.getNode();
          const blockNode = findParentNodeBlock(anchorNode);
          if (!blockNode) return;

          blockIdToIndent = blockNode.getBlockId();
          shouldOutdent = event?.shiftKey ?? false;
        });

        if (!blockIdToIndent) return false;

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

  // ─── Arrow up/down: cross-block navigation ────────────────

  useEffect(() => {
    const handleArrowUp = () => {
      let shouldMoveToPrev = false;
      let prevBlockNode: NodeBlockNode | null = null;

      editor.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return;

        // If at start of first line, move to previous block
        if (anchor.offset === 0) {
          const root = $getRoot();
          const children = root.getChildren();
          const blockIndex = children.indexOf(blockNode);
          if (blockIndex <= 0) return;

          const prevBlock = children[blockIndex - 1];
          if ($isNodeBlockNode(prevBlock)) {
            shouldMoveToPrev = true;
            prevBlockNode = prevBlock;
          }
        }
      });

      if (!shouldMoveToPrev || !prevBlockNode) return false;

      editor.update(() => {
        const lastChild = prevBlockNode!.getLastDescendant();
        if (lastChild) {
          lastChild.selectEnd();
        }
      });

      return true;
    };

    const handleArrowDown = () => {
      let shouldMoveToNext = false;
      let nextBlockNode: NodeBlockNode | null = null;

      editor.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return;

        // If at end, move to next block
        const textContent = blockNode.getTextContent();
        if (anchor.offset >= textContent.length) {
          const root = $getRoot();
          const children = root.getChildren();
          const blockIndex = children.indexOf(blockNode);
          if (blockIndex >= children.length - 1) return;

          const nextBlock = children[blockIndex + 1];
          if ($isNodeBlockNode(nextBlock)) {
            shouldMoveToNext = true;
            nextBlockNode = nextBlock;
          }
        }
      });

      if (!shouldMoveToNext || !nextBlockNode) return false;

      editor.update(() => {
        const firstChild = nextBlockNode!.getFirstDescendant();
        if (firstChild) {
          firstChild.selectStart();
        }
      });

      return true;
    };

    const unsubUp = editor.registerCommand(KEY_ARROW_UP_COMMAND, handleArrowUp, COMMAND_PRIORITY_NORMAL);
    const unsubDown = editor.registerCommand(KEY_ARROW_DOWN_COMMAND, handleArrowDown, COMMAND_PRIORITY_NORMAL);

    return () => {
      unsubUp();
      unsubDown();
    };
  }, [editor]);

  // ─── Escape ────────────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        onEscape?.();
        return true;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor, onEscape]);

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Populate a NodeBlockNode's children from a ContentAST.
 */
function populateBlockContent(block: NodeBlockNode, contentAST: ContentAST): void {
  if (!contentAST || contentAST.length === 0) {
    // Use zero-width space so empty blocks have a focusable cursor position
    block.append($createTextNode('\u200B'));
    return;
  }

  for (const para of contentAST) {
    for (const inline of para.children) {
      appendInlineNode(block, inline, 0);
    }
  }
}

/**
 * Recursively append inline nodes to a block, tracking format flags for nested marks.
 */
function appendInlineNode(parent: NodeBlockNode, inline: ASTInlineNode, format: number): void {
  switch (inline.type) {
    case 'text': {
      const textNode = $createTextNode(inline.text);
      if (format !== 0) {
        textNode.setFormat(format);
      }
      parent.append(textNode);
      break;
    }
    case 'hard_break': {
      // Treat as newline text for now
      parent.append($createTextNode('\\n'));
      break;
    }
    case 'node_link': {
      const pill = $createNodePillNode(inline.link_id, inline.ref_type);
      parent.append(pill);
      break;
    }
    case 'code': {
      const codeText = $createTextNode(inline.text);
      codeText.setFormat(format | 16); // IS_CODE
      parent.append(codeText);
      break;
    }
    case 'strong': {
      // Recurse into children with bold flag added
      for (const child of inline.children) {
        appendInlineNode(parent, child, format | 1); // IS_BOLD
      }
      break;
    }
    case 'em': {
      for (const child of inline.children) {
        appendInlineNode(parent, child, format | 2); // IS_ITALIC
      }
      break;
    }
    case 'strikethrough': {
      for (const child of inline.children) {
        appendInlineNode(parent, child, format | 4); // IS_STRIKETHROUGH
      }
      break;
    }
    case 'underline': {
      for (const child of inline.children) {
        appendInlineNode(parent, child, format | 8); // IS_UNDERLINE
      }
      break;
    }
    case 'highlight': {
      // No Lexical highlight format, just recurse
      for (const child of inline.children) {
        appendInlineNode(parent, child, format);
      }
      break;
    }
    case 'external_link': {
      // For now, render children as plain text
      for (const child of inline.children) {
        appendInlineNode(parent, child, format);
      }
      break;
    }
  }
}

/**
 * Extract content from a NodeBlockNode back into ContentAST.
 */
function extractBlockContent(block: NodeBlockNode): ContentAST {
  const children = block.getChildren();
  const inlines: ASTInlineNode[] = [];

  for (const child of children) {
    if ($isNodePillNode(child)) {
      inlines.push({
        type: 'node_link',
        link_id: child.getLinkId(),
        ref_type: child.getRefType(),
      });
    } else {
      const text = child.getTextContent();
      const format = (child as any).getFormat?.() ?? 0;
      
      // Build the AST node with nested marks
      let node: ASTInlineNode = { type: 'text', text };
      
      if (format & 16) {
        node = { type: 'code', text };
      } else {
        if (format & 8) node = { type: 'underline', children: [node] };
        if (format & 4) node = { type: 'strikethrough', children: [node] };
        if (format & 2) node = { type: 'em', children: [node] };
        if (format & 1) node = { type: 'strong', children: [node] };
      }
      
      inlines.push(node);
    }
  }

  return [{ type: 'paragraph', children: inlines.length > 0 ? inlines : [{ type: 'text', text: '' }] }];
}
