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
import type { ProjectedNode, ContentAST, ASTInlineNode, InlineMark } from '../../runtime/types';

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
          maxDepth: -1,
          includeRoot: false,
        });
        syncProjection(projection);
      }
    });

    // Initial sync
    const initialProjection = runtime.project({
      projectionId: editorId,
      rootBlockId,
      maxDepth: -1,
      includeRoot: false,
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
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;

        const anchorNode = selection.anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return false;

        event?.preventDefault();

        const blockId = blockNode.getBlockId();
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
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;
        if (!selection.isCollapsed()) return false;

        const anchor = selection.anchor;
        if (anchor.offset !== 0) return false;

        const anchorNode = anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return false;

        // Check if cursor is at the very start of the block
        const firstChild = blockNode.getFirstChild();
        if (anchorNode !== firstChild && anchorNode.getParent() !== blockNode) return false;

        event?.preventDefault();

        const root = $getRoot();
        const children = root.getChildren();
        const blockIndex = children.indexOf(blockNode);
        if (blockIndex <= 0) return true;

        const prevBlock = children[blockIndex - 1];
        if ($isNodeBlockNode(prevBlock)) {
          onBlockMerge?.(blockNode.getBlockId(), prevBlock.getBlockId());
        }

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
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;
        if (!selection.isCollapsed()) return false;

        const anchorNode = selection.anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return false;

        // Check if at end of block
        const textContent = blockNode.getTextContent();
        const anchor = selection.anchor;
        if (anchor.offset < textContent.length) return false;

        event?.preventDefault();

        const root = $getRoot();
        const children = root.getChildren();
        const blockIndex = children.indexOf(blockNode);
        if (blockIndex >= children.length - 1) return true;

        const nextBlock = children[blockIndex + 1];
        if ($isNodeBlockNode(nextBlock)) {
          onBlockMerge?.(nextBlock.getBlockId(), blockNode.getBlockId());
        }

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
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;

        const anchorNode = selection.anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return false;

        event?.preventDefault();

        const blockId = blockNode.getBlockId();
        if (event?.shiftKey) {
          onOutdent?.(blockId);
        } else {
          onIndent?.(blockId);
        }

        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, onIndent, onOutdent]);

  // ─── Arrow up/down: cross-block navigation ────────────────

  useEffect(() => {
    const handleArrowUp = () => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;

      const anchor = selection.anchor;
      const anchorNode = anchor.getNode();
      const blockNode = findParentNodeBlock(anchorNode);
      if (!blockNode) return false;

      // If at start of first line, move to previous block
      if (anchor.offset === 0) {
        const root = $getRoot();
        const children = root.getChildren();
        const blockIndex = children.indexOf(blockNode);
        if (blockIndex <= 0) return false;

        const prevBlock = children[blockIndex - 1];
        if ($isNodeBlockNode(prevBlock)) {
          const lastChild = prevBlock.getLastDescendant();
          if (lastChild) {
            lastChild.selectEnd();
            return true;
          }
        }
      }

      return false;
    };

    const handleArrowDown = () => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;

      const anchor = selection.anchor;
      const anchorNode = anchor.getNode();
      const blockNode = findParentNodeBlock(anchorNode);
      if (!blockNode) return false;

      // If at end, move to next block
      const textContent = blockNode.getTextContent();
      if (anchor.offset >= textContent.length) {
        const root = $getRoot();
        const children = root.getChildren();
        const blockIndex = children.indexOf(blockNode);
        if (blockIndex >= children.length - 1) return false;

        const nextBlock = children[blockIndex + 1];
        if ($isNodeBlockNode(nextBlock)) {
          const firstChild = nextBlock.getFirstDescendant();
          if (firstChild) {
            firstChild.selectStart();
            return true;
          }
        }
      }

      return false;
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

function findParentNodeBlock(node: any): NodeBlockNode | null {
  let current = node;
  while (current != null) {
    if ($isNodeBlockNode(current)) return current;
    current = current.getParent?.();
  }
  return null;
}

/**
 * Populate a NodeBlockNode's children from a ContentAST.
 */
function populateBlockContent(block: NodeBlockNode, contentAST: ContentAST): void {
  if (!contentAST || contentAST.length === 0) {
    block.append($createTextNode(''));
    return;
  }

  for (const para of contentAST) {
    for (const inline of para.children) {
      appendInlineNode(block, inline);
    }
  }
}

function appendInlineNode(parent: NodeBlockNode, inline: ASTInlineNode): void {
  switch (inline.type) {
    case 'text': {
      const textNode = $createTextNode(inline.text);
      if (inline.marks) {
        let format = 0;
        for (const mark of inline.marks) {
          switch (mark) {
            case 'strong': format |= 1; break;  // IS_BOLD
            case 'em': format |= 2; break;       // IS_ITALIC
            case 'strikethrough': format |= 4; break; // IS_STRIKETHROUGH
            case 'underline': format |= 8; break; // IS_UNDERLINE
            case 'code': format |= 16; break;    // IS_CODE
          }
        }
        textNode.setFormat(format);
      }
      parent.append(textNode);
      break;
    }
    case 'node_link': {
      const pill = $createNodePillNode(inline.linkId, inline.refType);
      parent.append(pill);
      break;
    }
    case 'code_span': {
      const codeText = $createTextNode(inline.text);
      codeText.setFormat(16); // IS_CODE
      parent.append(codeText);
      break;
    }
    case 'external_link': {
      // For now, render as plain text with a mark
      for (const child of inline.children) {
        appendInlineNode(parent, child);
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
        linkId: child.getLinkId(),
        refType: child.getRefType(),
      });
    } else {
      const text = child.getTextContent();
      const marks: InlineMark[] = [];

      // Check format flags
      const format = (child as any).getFormat?.() ?? 0;
      if (format & 1) marks.push('strong');
      if (format & 2) marks.push('em');
      if (format & 4) marks.push('strikethrough');
      if (format & 8) marks.push('underline');

      if (format & 16) {
        inlines.push({ type: 'code_span', text });
      } else {
        inlines.push({ type: 'text', text, marks: marks.length > 0 ? marks : undefined });
      }
    }
  }

  return [{ type: 'paragraph', children: inlines.length > 0 ? inlines : [{ type: 'text', text: '' }] }];
}
