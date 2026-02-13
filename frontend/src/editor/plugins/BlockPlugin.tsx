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
  $createNodeSelection,
  $setSelection,
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
  // so syncProjection only runs once per flush cycle.
  // If a second event fires while the first sync is in progress the
  // dirty flag ensures we re-sync after the microtask so no state is lost.
  const syncCoalesceRef = useRef(false);
  const syncDirtyRef = useRef(false);

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
          // Sync classIds (compare as joined string to avoid reference inequality)
          const existingClassStr = existing.getClassIds().join(',');
          const projectedClassStr = (projected.classIds ?? []).join(',');
          if (existingClassStr !== projectedClassStr) existing.setClassIds(projected.classIds ?? []);
          
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
            projected.classIds ?? [],
          );

          // Populate inline content from contentAST
          populateBlockContent(newBlock, projected.contentAST);

          // Temporarily append — ordering is fixed in PASS 3
          root.append(newBlock);

          blockIdToKeyMap.current.set(projected.blockId, newBlock.getKey());
          existingBlockMap.set(projected.blockId, newBlock);
          
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

      // PASS 3: Reorder Lexical children to match projected order.
      // After PASS 1 (update) and PASS 2 (create), the Lexical tree may
      // have nodes in the wrong order — existing nodes keep their old
      // positions and newly appended nodes land at the end.  Walk the
      // projected list and move each BlockNode into the correct slot.
      let prevBlock: BlockNode | null = null;
      for (const projected of visibleNodes) {
        const block = existingBlockMap.get(projected.blockId);
        if (!block) continue;
        if (prevBlock) {
          // Move block to be right after its predecessor (no-op if already there)
          prevBlock.insertAfter(block);
        }
        prevBlock = block;
      }
    }, { tag: 'runtime-sync' });

    // If we consumed a pending focus, ensure the DOM ContentEditable
    // actually has focus (it may have been blurred by an external click,
    // e.g. the "Add block" button).
    if (pendingFocus && !runtime.getPendingFocus()) {
      editor.focus();
    }

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
        // back-to-back.  We sync once immediately and, if more events
        // arrived during the sync, re-sync after the microtask so the
        // final state is always reflected in Lexical.
        if (!syncCoalesceRef.current) {
          syncCoalesceRef.current = true;
          syncDirtyRef.current = false;
          syncProjection(getProjection());
          Promise.resolve().then(() => {
            syncCoalesceRef.current = false;
            if (syncDirtyRef.current) {
              syncDirtyRef.current = false;
              syncProjection(getProjection());
            }
          });
        } else {
          // Mark dirty so the microtask re-syncs with the final state
          syncDirtyRef.current = true;
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

    return editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves, tags }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      // Skip content saves triggered by external sync (runtime → Lexical)
      // Only save when the user actually edited content
      if (isSyncingRef.current || tags.has('runtime-sync')) return;

      editorState.read(() => {
        const root = $getRoot();
        for (const child of root.getChildren()) {
          if (!$isBlockNode(child)) continue;

          // A block needs content extraction when it is structurally dirty
          // (children added/removed, caught by dirtyElements) OR when one
          // of its leaf children changed in-place (e.g. TextNode format
          // toggled by FORMAT_TEXT_COMMAND, caught by dirtyLeaves).
          const blockDirty =
            dirtyElements.has(child.getKey()) ||
            child.getChildren().some((c) => dirtyLeaves.has(c.getKey()));

          if (blockDirty) {
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

        // Command handlers run inside a Lexical state context —
        // call $getSelection() directly (NOT inside editor.read()).
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;

        const anchorNode = selection.anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return false;

        const blockId = blockNode.getBlockId();

        // Calculate cursor offset by walking through block children
        let cursorOffset = 0;
        const children = blockNode.getChildren();
        for (const child of children) {
          if (child === anchorNode || child.getKey() === anchorNode.getKey()) {
            cursorOffset += selection.anchor.offset;
            break;
          }
          if ($isTextNode(child)) {
            cursorOffset += child.getTextContent().length;
          } else if ($isPillNode(child)) {
            cursorOffset += 1; // Pills count as 1 character
          } else {
            cursorOffset += child.getTextContent().length;
          }
        }

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
        // Command handlers run inside a Lexical state context —
        // call $getSelection() directly (NOT inside editor.read()).
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;
        if (!selection.isCollapsed()) return false;

        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        const blockNode = findParentNodeBlock(anchorNode);
        if (!blockNode) return false;

        // Check if block is effectively empty (only contains zero-width space or empty).
        // DecoratorNodes like PillNode return '' from getTextContent(), so a block
        // containing only pills would appear empty by text alone — check for pills too.
        const textContent = blockNode.getTextContent();
        const hasPillNodes = blockNode.getChildren().some(child => $isPillNode(child));
        const isEmptyBlock = (textContent === '' || textContent === '\u200B') && !hasPillNodes;

        // A block that has pills but no meaningful text (only ZWS placeholders).
        // These should NOT be merged/deleted — backspace selects the pill first.
        const textWithoutZWS = textContent.replace(/\u200B/g, '');
        const isPillOnlyBlock = hasPillNodes && textWithoutZWS === '';

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

        // Pill-only block: select the pill instead of merging/deleting.
        // This way backspace transitions pill → selected-pill → removed-pill → empty-block → delete.
        if (isPillOnlyBlock) {
          const pillChild = blockNode.getChildren().find(child => $isPillNode(child));
          if (pillChild) {
            event?.preventDefault();
            const sel = $createNodeSelection();
            sel.add(pillChild.getKey());
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
          event?.preventDefault();
          onBlockMerge?.(blockNode.getBlockId(), prevBlock.getBlockId());
          return true;
        }

        return false;
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
          event?.preventDefault();
          onBlockMerge?.(nextBlock.getBlockId(), blockNode.getBlockId());
          return true;
        }

        return false;
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

      // Must be at the absolute start of the block
      if (anchor.offset !== 0) return false;
      if (anchor.type === 'text' && anchorNode !== blockNode.getFirstDescendant()) return false;

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

      // Must be at the absolute end of the block
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

      // Block arrow up on first block to prevent cursor from entering empty root space
      if (blockIndex <= 0) return true;

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

      // Block arrow down on last block to prevent cursor from entering empty root space
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

  // Check if the AST is effectively empty (single paragraph with only empty text)
  const isEffectivelyEmpty = contentAST.length === 1
    && contentAST[0].children.length === 1
    && contentAST[0].children[0].type === 'text'
    && contentAST[0].children[0].text === '';

  if (isEffectivelyEmpty) {
    block.append($createTextNode('\u200B'));
    return;
  }

  for (const para of contentAST) {
    for (const inline of para.children) {
      appendInlineNode(block, inline, 0);
    }
  }

  // Ensure there's always a text node after the last element for proper cursor placement
  // This is especially important when the last element is a pill
  // Use zero-width space to prevent Lexical from removing the text node
  const children = block.getChildren();
  const lastChild = children[children.length - 1];
  if (lastChild && ($isPillNode(lastChild) || $isLineBreakNode(lastChild))) {
    block.append($createTextNode('\u200B'));
  }
}

/**
 * Recursively append inline nodes to a block, tracking format flags for nested marks.
 * Also ensures text nodes exist around pills for proper cursor navigation.
 */
function appendInlineNode(parent: BlockNode, inline: ASTInlineNode, format: number, isFirst: boolean = false): void {
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
      // Ensure there's a text node before the pill if this is the first element
      // or if the previous sibling is also a pill
      // Use zero-width space to prevent Lexical from removing the text node
      const children = parent.getChildren();
      const lastChild = children[children.length - 1];
      if (children.length === 0 || $isPillNode(lastChild)) {
        parent.append($createTextNode('\u200B'));
      }
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
