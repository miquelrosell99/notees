/**
 * BlockPlugin — Lexical plugin that manages BlockNode lifecycle.
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
  $isTextNode,
  $isLineBreakNode,
  TextNode,
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
  $createLineBreakNode,
} from 'lexical';

import {
  $createBlockNode,
  $isBlockNode,
  BlockNode,
} from '../nodes/BlockNode';
import { $createPillNode, $isPillNode } from '../nodes/PillNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { findParentNodeBlock } from '../utils/selectionUtils';
import type { ProjectedNode, ContentAST } from '../../runtime/types';
import type { ASTInlineNode } from '@/types/ast';

// ─── Props ────────────────────────────────────────────────────────

export interface BlockPluginProps {
  /** The editor instance ID */
  editorId: string;
  /** The root blockId to project from */
  rootBlockId: string;
  /** Called when a block's content changes */
  onContentChange?: (blockId: string, contentAST: ContentAST) => void;
  /** Called when blocks should be merged */
  onBlockMerge?: (sourceBlockId: string, targetBlockId: string) => void;
  /** Called when a block should be deleted */
  onBlockDelete?: (blockId: string) => void;
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
  /** Slice projection: block IDs in the slice (overrides rootBlockId-based projection) */
  sliceBlockIds?: string[];
  /** Slice projection: how many levels of children to expand (-1 = unlimited) */
  sliceRecursiveLevel?: number;
  /** Slice projection: whether to show parent nodes as locked projection roots */
  sliceShowParent?: boolean;
}

// ─── Plugin component ─────────────────────────────────────────────

export function BlockPlugin({
  editorId,
  rootBlockId,
  onContentChange,
  onBlockMerge,
  onBlockDelete,
  onIndent,
  onOutdent,
  // onEscape is handled by KeyboardSelectionPlugin (COMMAND_PRIORITY_HIGH)
  onEscape: _onEscape,
  readOnly = false,
  includeRoot = false,
  maxDepth = -1,
  sliceBlockIds,
  sliceRecursiveLevel,
  sliceShowParent,
}: BlockPluginProps): null {
  const [editor] = useLexicalComposerContext();
  const blockIdToKeyMap = useRef(new Map<string, string>());
  // Flag to suppress content change callbacks during external sync
  const isSyncingRef = useRef(false);
  // Coalesce multiple runtime events (e.g. nodes_changed + structure_changed)
  // so syncProjection only runs once per flush cycle
  const syncCoalesceRef = useRef(false);

  // ─── Sync projected nodes into Lexical ──────────────────────

  const syncProjection = useCallback((projectedNodes: ProjectedNode[]) => {
    // Set flag BEFORE the update so the update listener skips content saves
    isSyncingRef.current = true;
    
    // Check if runtime is requesting focus on a specific block
    const runtime = getNodeGraphRuntime();
    const pendingFocus = runtime.getPendingFocus();
    
    editor.update(() => {
      const root = $getRoot();
      const existingNodes = root.getChildren();
      const existingBlockMap = new Map<string, BlockNode>();

      for (const child of existingNodes) {
        if ($isBlockNode(child)) {
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

      // Two-pass approach: update existing nodes first, then create new ones
      // This ensures focus-setting on new blocks happens after all content updates
      const visibleNodes = projectedNodes.filter(n => n.visible);
      
      // PASS 1: Update all existing nodes
      for (let i = 0; i < visibleNodes.length; i++) {
        const projected = visibleNodes[i];
        const existing = existingBlockMap.get(projected.blockId);

        if (existing) {
          // Update existing node — only call setters when values actually
          // changed to avoid dirtying nodes unnecessarily, which causes
          // Lexical to reconcile and reset the cursor/selection.
          if (existing.getDepth() !== projected.depth) existing.setDepth(projected.depth);
          if (existing.getCollapsed() !== projected.collapsed) existing.setCollapsed(projected.collapsed);
          if (existing.getHasChildren() !== projected.hasChildren) existing.setHasChildren(projected.hasChildren);
          if (existing.getIcon() !== (projected.icon ?? null)) existing.setIcon(projected.icon ?? null);
          if (existing.getColor() !== (projected.color ?? null)) existing.setColor(projected.color ?? null);
          if (existing.getBlockName() !== (projected.name ?? '')) existing.setBlockName(projected.name ?? '');
          if (existing.getIsProjectionRoot() !== projected.isProjectionRoot) existing.setIsProjectionRoot(projected.isProjectionRoot);
          
          // Check if content has changed (e.g., from split_block or merge_blocks operation)
          // Compare serialized content to detect changes
          const currentContent = extractBlockContent(existing);
          const currentSerialized = JSON.stringify(currentContent);
          const projectedSerialized = JSON.stringify(projected.contentAST);
          
          if (currentSerialized !== projectedSerialized) {
            // Content changed - clear and repopulate
            // Clear existing children
            const children = existing.getChildren();
            for (const child of children) {
              child.remove();
            }
            
            // Repopulate with new content
            populateBlockContent(existing, projected.contentAST);
          }
          
          // Handle pending focus on existing blocks (e.g. after merge_blocks
          // the target block is existing but needs cursor at merge offset)
          if (pendingFocus && projected.blockId === pendingFocus.blockId) {
            runtime.clearPendingFocus();
            if (pendingFocus.offset != null) {
              // Walk children to find the right cursor position at the given character offset
              let remaining = pendingFocus.offset;
              const blockChildren = existing.getChildren();
              let focused = false;
              for (const child of blockChildren) {
                if ($isTextNode(child)) {
                  const len = child.getTextContentSize();
                  if (remaining <= len) {
                    child.select(remaining, remaining);
                    focused = true;
                    break;
                  }
                  remaining -= len;
                } else {
                  // PillNode or other: counts as 1 character
                  if (remaining <= 0) {
                    child.selectPrevious();
                    focused = true;
                    break;
                  }
                  remaining -= 1;
                }
              }
              if (!focused) {
                // Offset beyond content — place at end
                const last = existing.getLastDescendant();
                if (last) last.selectEnd();
                else existing.selectEnd();
              }
            } else {
              existing.selectStart();
            }
          }
        }
      }
      
      // PASS 2: Create new nodes and set focus
      // Do this after all content updates to avoid selection disruption
      for (let i = 0; i < visibleNodes.length; i++) {
        const projected = visibleNodes[i];
        const existing = existingBlockMap.get(projected.blockId);
        
        if (!existing) {
          // Create new node
          const newBlock = $createBlockNode(
            projected.blockId,
            projected.depth,
            projected.collapsed,
            projected.nodeType,
            projected.hasChildren,
            projected.icon ?? null,
            projected.color ?? null,
            projected.name ?? '',
            projected.isProjectionRoot,
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
          
          // If this is the block runtime requested to focus, focus it directly
          if (pendingFocus && projected.blockId === pendingFocus.blockId) {
            runtime.clearPendingFocus();
            const firstChild = newBlock.getFirstChild();
            if (firstChild) {
              if (pendingFocus.offset != null && $isTextNode(firstChild)) {
                firstChild.select(pendingFocus.offset, pendingFocus.offset);
              } else if ($isTextNode(firstChild)) {
                firstChild.selectStart();
              } else {
                newBlock.selectStart();
              }
            } else {
              newBlock.selectStart();
            }
          }
        }
      }
    }, { tag: 'runtime-sync' });
    // Reset flag after a microtask - Lexical update listeners fire before this
    Promise.resolve().then(() => { isSyncingRef.current = false; });
  }, [editor]);

  // ─── Subscribe to runtime events ───────────────────────────

  useEffect(() => {
    const runtime = getNodeGraphRuntime();
    const isSliceMode = sliceBlockIds && sliceBlockIds.length > 0;

    const getProjection = () => {
      if (isSliceMode) {
        return runtime.projectSlice({
          projectionId: editorId,
          nodeBlockIds: sliceBlockIds!,
          recursiveLevel: sliceRecursiveLevel ?? -1,
          showParent: sliceShowParent ?? false,
        });
      }
      return runtime.project({
        projectionId: editorId,
        rootBlockId,
        maxDepth,
        includeRoot,
      });
    };

    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'nodes_changed' || event.type === 'structure_changed') {
        // Coalesce: flushEvents() fires nodes_changed + structure_changed
        // back-to-back. Only sync once per synchronous cycle.
        if (!syncCoalesceRef.current) {
          syncCoalesceRef.current = true;
          syncProjection(getProjection());
          Promise.resolve().then(() => { syncCoalesceRef.current = false; });
        }
      }
    });

    // Initial sync
    syncProjection(getProjection());

    return unsubscribe;
  }, [editor, editorId, rootBlockId, syncProjection, sliceBlockIds, sliceRecursiveLevel, sliceShowParent]);

  // ─── ZWS cleanup transform ────────────────────────────────
  // Empty blocks use a zero-width space (\u200B) so the cursor
  // has a focusable position.  When the user types real content
  // into such a node the ZWS must be removed — otherwise it
  // pollutes stored data AND breaks trigger-pattern detection
  // (e.g. the "/" slash command regex expects start-of-text or
  // whitespace before the slash, but ZWS is neither).

  useEffect(() => {
    return editor.registerNodeTransform(TextNode, (node) => {
      const raw = node.getTextContent();
      if (raw.length > 1 && raw.includes('\u200B')) {
        const clean = raw.replace(/\u200B/g, '');
        if (clean.length > 0) {
          node.setTextContent(clean);
        }
      }
    });
  }, [editor]);

  // ─── Text change listener ──────────────────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerUpdateListener(({ editorState, dirtyElements, tags }) => {
      if (dirtyElements.size === 0) return;
      // Skip content saves triggered by external sync (runtime → Lexical)
      // Only save when the user actually edited content
      if (isSyncingRef.current || tags.has('runtime-sync')) return;

      editorState.read(() => {
        const root = $getRoot();
        for (const child of root.getChildren()) {
          if ($isBlockNode(child) && dirtyElements.has(child.getKey())) {
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

        let blockId: string | null = null;
        let cursorOffset = 0;

        editor.read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;

          const anchorNode = selection.anchor.getNode();
          const blockNode = findParentNodeBlock(anchorNode);
          if (!blockNode) return;

          blockId = blockNode.getBlockId();

          // Calculate cursor offset by walking through block children
          let offset = 0;
          const children = blockNode.getChildren();
          for (const child of children) {
            if (child === anchorNode || child.getKey() === anchorNode.getKey()) {
              // Found the node with the cursor
              offset += selection.anchor.offset;
              break;
            }
            // Add this child's text length
            if ($isTextNode(child)) {
              offset += child.getTextContent().length;
            } else if ($isPillNode(child)) {
              offset += 1; // Pills count as 1 character
            } else {
              offset += child.getTextContent().length;
            }
          }
          cursorOffset = offset;
        });

        if (!blockId) return false;

        event?.preventDefault();

        const runtime = getNodeGraphRuntime();
        const newBlockId = crypto.randomUUID();
        runtime.requestFocus(newBlockId);

        if (includeRoot && blockId === rootBlockId) {
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
  }, [editor, readOnly, includeRoot, rootBlockId]);

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
          
          // Only merge/delete when cursor is at the absolute start of the block
          if (!isEmptyBlock) {
            if (anchor.offset !== 0) return;
            // For text anchors: must be the deepest-first node of the block
            // For element anchors: must be the block itself at child index 0
            if (anchor.type === 'text') {
              if (anchorNode !== blockNode.getFirstDescendant()) return;
            } else {
              if (anchorNode !== blockNode) return;
            }
          }

          const root = $getRoot();
          const children = root.getChildren();
          const blockIndex = children.indexOf(blockNode);

          // Handle first block specially
          if (blockIndex === 0) {
            // If first block is empty, delete it (even if it's the only block)
            if (isEmptyBlock) {
              currentBlockId = blockNode.getBlockId();
              // Set a flag to indicate we want to delete, not merge
              prevBlockId = null;
            } else if (anchor.offset === 0) {
              // At start of non-empty first block - can't merge, just prevent default
              event?.preventDefault();
            }
            return;
          }

          if (blockIndex < 0) return;

          const prevBlock = children[blockIndex - 1];
          if ($isBlockNode(prevBlock)) {
            currentBlockId = blockNode.getBlockId();
            prevBlockId = prevBlock.getBlockId();
          }
        });

        if (!currentBlockId) return false;

        event?.preventDefault();
        
        // If prevBlockId is null, this is a delete operation (empty first block)
        if (prevBlockId === null) {
          onBlockDelete?.(currentBlockId);
        } else {
          onBlockMerge?.(currentBlockId, prevBlockId);
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, onBlockMerge, onBlockDelete]);

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

          // Check if cursor is at the absolute end of the block
          const anchor = selection.anchor;
          if (anchor.type === 'text') {
            const lastDescendant = blockNode.getLastDescendant();
            if (anchorNode !== lastDescendant || anchor.offset < anchorNode.getTextContentSize()) return;
          } else {
            if (anchorNode !== blockNode || anchor.offset < blockNode.getChildrenSize()) return;
          }

          const root = $getRoot();
          const children = root.getChildren();
          const blockIndex = children.indexOf(blockNode);
          if (blockIndex >= children.length - 1) return;

          const nextBlock = children[blockIndex + 1];
          if ($isBlockNode(nextBlock)) {
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

  // ─── Left/Right: navigate between blocks ──────────────────

  useEffect(() => {
    if (readOnly) return;

    const handleArrowLeft = (event: KeyboardEvent | null) => {
      let prevBlockNode: BlockNode | null = null;

      editor.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        if (!selection.isCollapsed()) return;

        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return;

        // Must be at the absolute start of the block
        if (anchor.offset !== 0) return;
        if (anchor.type === 'text' && anchorNode !== blockNode.getFirstDescendant()) return;
        if (!blockNode) return;

        const root = $getRoot();
        const children = root.getChildren();
        const blockIndex = children.indexOf(blockNode);
        if (blockIndex <= 0) return;

        const prevBlock = children[blockIndex - 1];
        if ($isBlockNode(prevBlock)) {
          prevBlockNode = prevBlock;
        }
      });

      if (!prevBlockNode) return false;

      event?.preventDefault();
      editor.update(() => {
        const lastChild = prevBlockNode!.getLastDescendant();
        if (lastChild) {
          lastChild.selectEnd();
        }
      });

      return true;
    };

    const handleArrowRight = (event: KeyboardEvent | null) => {
      let nextBlockNode: BlockNode | null = null;

      editor.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        if (!selection.isCollapsed()) return;

        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return;

        // Must be at the absolute end of the block
        if (anchor.type === 'text') {
          const lastDescendant = blockNode.getLastDescendant();
          if (anchorNode !== lastDescendant || anchor.offset < anchorNode.getTextContentSize()) return;
        } else {
          if (anchorNode !== blockNode || anchor.offset < blockNode.getChildrenSize()) return;
        }

        const root = $getRoot();
        const children = root.getChildren();
        const blockIndex = children.indexOf(blockNode);
        if (blockIndex >= children.length - 1) return;

        const nextBlock = children[blockIndex + 1];
        if ($isBlockNode(nextBlock)) {
          nextBlockNode = nextBlock;
        }
      });

      if (!nextBlockNode) return false;

      event?.preventDefault();
      editor.update(() => {
        const firstChild = nextBlockNode!.getFirstDescendant();
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
      let isFirstBlock = false;

      editor.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        const anchorNode = selection.anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return;

        const root = $getRoot();
        const children = root.getChildren();
        const blockIndex = children.indexOf(blockNode);

        if (blockIndex <= 0) {
          // On the first block — prevent cursor from escaping into empty space
          isFirstBlock = true;
        }
      });

      // Block arrow up on first block to prevent cursor from entering empty root space
      if (isFirstBlock) return true;

      // Let default arrow behavior handle vertical movement
      return false;
    };

    const handleArrowDown = () => {
      let isLastBlock = false;

      editor.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        const anchorNode = selection.anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return;

        const root = $getRoot();
        const children = root.getChildren();
        const blockIndex = children.indexOf(blockNode);

        if (blockIndex >= children.length - 1) {
          // On the last block — prevent cursor from escaping into empty space
          isLastBlock = true;
        }
      });

      // Block arrow down on last block to prevent cursor from entering empty root space
      if (isLastBlock) return true;

      // Let default arrow behavior handle vertical movement
      return false;
    };

    const unsubUp = editor.registerCommand(KEY_ARROW_UP_COMMAND, handleArrowUp, COMMAND_PRIORITY_NORMAL);
    const unsubDown = editor.registerCommand(KEY_ARROW_DOWN_COMMAND, handleArrowDown, COMMAND_PRIORITY_NORMAL);

    return () => {
      unsubUp();
      unsubDown();
    };
  }, [editor]);

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Populate a BlockNode's children from a ContentAST.
 */
function populateBlockContent(block: BlockNode, contentAST: ContentAST): void {
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
function appendInlineNode(parent: BlockNode, inline: ASTInlineNode, format: number): void {
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
      parent.append($createLineBreakNode());
      break;
    }
    case 'node_link': {
      const pill = $createPillNode(inline.link_id, inline.ref_type);
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
 * Extract content from a BlockNode back into ContentAST.
 */
function extractBlockContent(block: BlockNode): ContentAST {
  const children = block.getChildren();
  const inlines: ASTInlineNode[] = [];

  for (const child of children) {
    if ($isPillNode(child)) {
      inlines.push({
        type: 'node_link',
        link_id: child.getLinkId(),
        ref_type: child.getRefType(),
      });
    } else if ($isLineBreakNode(child)) {
      inlines.push({ type: 'hard_break' });
    } else {
      const text = child.getTextContent();
      // Skip zero-width space placeholders from empty blocks
      if (text === '\u200B') continue;
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
