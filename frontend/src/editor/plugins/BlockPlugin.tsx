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
  $getNodeByKey,
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
  MOVE_TO_START,
  MOVE_TO_END,
  $createLineBreakNode,
} from 'lexical';

import {
  $createBlockNode,
  $isBlockNode,
  BlockNode,
} from '../nodes/BlockNode';
import { $createInlineLinkNode, $isInlineLinkNode } from '../nodes/InlineLinkNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { findParentNodeBlock } from '../utils/selectionUtils';
import type { ProjectedNode, ContentAST } from '../../runtime/types';
import type { ASTInlineNode } from '@/types/ast';
import {
  getVisibleBlockIds,
  isVirtualizationEnabled,
  isBlockPopulated,
  markPopulated,
  markDepopulated,
  clearPopulatedState,
  prunePopulatedState,
  subscribeToVisibilityChange,
  flushVisibilityChanges,
} from '../virtualizedState';

/**
 * Number of blocks to eagerly populate on initial sync when the
 * IntersectionObserver hasn’t reported visibility yet.  Set high
 * enough to fill the viewport + buffer (400 px each side).
 */
const INITIAL_POPULATE_COUNT = 100;

/**
 * Number of blocks beyond the visible window to pre-hydrate during
 * idle time (above and below).  Blocks in this buffer will be
 * ready before the user scrolls to them.
 */
const PRE_HYDRATE_COUNT = 30;

/**
 * Maximum number of blocks to hydrate in a single idle callback.
 * If more remain, a continuation idle callback is scheduled so that
 * long pre-hydration queues never block the main thread.
 */
const IDLE_CHUNK_SIZE = 8;

/**
 * Fallback timeout (ms) for Phase-2 pill upgrades.
 * If requestIdleCallback hasn't fired within this window (e.g. during
 * constant scrolling), a setTimeout forces the upgrade so decorators
 * are never indefinitely delayed.
 */
const UPGRADE_FALLBACK_MS = 200;

/** Shim for requestIdleCallback in Safari / older browsers. */
const rIC: typeof requestIdleCallback =
  typeof requestIdleCallback !== 'undefined'
    ? requestIdleCallback
    : (cb) => setTimeout(() => cb({
        didTimeout: false,
        timeRemaining: () => 16,
      } as IdleDeadline), 16) as unknown as ReturnType<typeof requestIdleCallback>;
const cIC: typeof cancelIdleCallback =
  typeof cancelIdleCallback !== 'undefined'
    ? cancelIdleCallback
    : (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);

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
  /** Called for move up/down */
  onMoveUp?: (blockId: string) => void;
  onMoveDown?: (blockId: string) => void;
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
  /** Called when Enter is pressed on the root block (instead of creating a child) */
  onEnterAtRoot?: () => void;
  /** Called when UP arrow is pressed at the very first block (escape upward from embed) */
  onNavigateUpFromTop?: () => void;
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
  onMoveUp,
  onMoveDown,
  // onEscape is handled by KeyboardSelectionPlugin (COMMAND_PRIORITY_HIGH)
  onEscape: _onEscape,
  readOnly = false,
  includeRoot = false,
  maxDepth = -1,
  sliceBlockIds,
  sliceRecursiveLevel,
  sliceShowParent,
  onEnterAtRoot,
  onNavigateUpFromTop,
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
    
    // Flush any debounced visibility changes so we have the freshest
    // visible-block set before deciding what to populate.
    flushVisibilityChanges();

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

      // On initial sync (no existing blocks), clear stale population tracking
      if (existingBlockMap.size === 0) {
        clearPopulatedState();
      }

      // Snapshot visibility for this sync pass
      const visibleIds = getVisibleBlockIds();
      const virtEnabled = isVirtualizationEnabled();

      // Remove nodes no longer in projection and clean up tracking
      for (const [blockId, node] of existingBlockMap) {
        if (!newBlockIds.has(blockId)) {
          node.remove();
          blockIdToKeyMap.current.delete(blockId);
          markDepopulated(blockId);
        }
      }

      // Prune stale population tracking to prevent memory leaks
      prunePopulatedState(newBlockIds);

      // Two-pass approach: update existing nodes first, then create new ones
      // This ensures focus-setting on new blocks happens after all content updates
      const visibleNodes = projectedNodes.filter(n => n.visible);

      // Detect stale visible IDs: if virtualization is active but none
      // of the current visible IDs match the new projection (e.g. page
      // navigation), the IDs are leftover from a previous page.  In that
      // case we fall back to the INITIAL_POPULATE_COUNT eager strategy
      // so the user sees content immediately instead of ZWS placeholders.
      const visibleIdsRelevant = virtEnabled && visibleIds.size > 0 &&
        visibleNodes.some(n => visibleIds.has(n.blockId));
      
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
          // Only compare content for blocks whose content is actually populated in Lexical.
          // Off-screen blocks have ZWS placeholder — skip the expensive JSON.stringify.
          if (isBlockPopulated(projected.blockId)) {
            const currentContent = extractBlockContent(existing);
            const currentSerialized = JSON.stringify(currentContent);
            const projectedSerialized = JSON.stringify(projected.contentAST);
            
            if (currentSerialized !== projectedSerialized) {
              // Content changed - clear and repopulate
              const children = existing.getChildren();
              for (const child of children) {
                child.remove();
              }
              populateBlockContent(existing, projected.contentAST);
            }
          }
          
          // Handle pending focus on existing blocks (e.g. after merge_blocks
          // the target block is existing but needs cursor at merge offset).
          // Ensure content is populated before setting cursor — a focus target
          // may be off-screen and still have only a ZWS placeholder.
          if (pendingFocus && projected.blockId === pendingFocus.blockId) {
            runtime.clearPendingFocus();

            // Force-populate if content was dehydrated
            if (!isBlockPopulated(projected.blockId)) {
              const children = existing.getChildren();
              for (const child of children) child.remove();
              populateBlockContent(existing, projected.contentAST);
              markPopulated(projected.blockId);
            }

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
                  // InlineLinkNode or other: counts as 1 character
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

          // Populate inline content from contentAST.
          // When virtualization is active and IO hasn't reported yet (visibleIds
          // empty OR stale from a previous page), eagerly populate the first
          // INITIAL_POPULATE_COUNT blocks so the viewport has content
          // immediately.  Off-screen blocks get a ZWS placeholder; their
          // content is populated lazily when they scroll into view.
          const shouldPopulate =
            !virtEnabled ||
            (!visibleIdsRelevant
              ? i < INITIAL_POPULATE_COUNT
              : visibleIds.has(projected.blockId) ||
                (pendingFocus != null && projected.blockId === pendingFocus.blockId));

          if (shouldPopulate) {
            populateBlockContent(newBlock, projected.contentAST);
            markPopulated(projected.blockId);
          } else {
            // Off-screen: lightweight ZWS placeholder for focusable cursor
            newBlock.append($createTextNode('\u200B'));
          }

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

  // ─── Visibility-driven content hydration / dehydration ─────
  // When a block scrolls into view, mount its text immediately
  // (Phase 1 — light populate) so the user sees content, then
  // schedule an idle callback to upgrade pills (Phase 2).
  // When it scrolls out, replace content with a ZWS placeholder.

  useEffect(() => {
    // Blocks that have been light-populated but still need pill upgrade
    const pendingUpgrade = new Set<string>();
    let upgradeHandle: ReturnType<typeof rIC> | null = null;

    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    /** Run a single pass of pending upgrades (shared by idle + fallback). */
    function runUpgradePass(deadline: { timeRemaining: () => number } | null) {
      if (pendingUpgrade.size === 0) return;
      isSyncingRef.current = true;
      editor.update(() => {
        const runtime = getNodeGraphRuntime();
        for (const blockId of pendingUpgrade) {
          // Respect deadline when running from rIC; fallback passes null (no limit).
          if (deadline && deadline.timeRemaining() < 2) break;

          const key = blockIdToKeyMap.current.get(blockId);
          if (!key) { pendingUpgrade.delete(blockId); continue; }
          const block = $getNodeByKey(key);
          if (!$isBlockNode(block)) { pendingUpgrade.delete(blockId); continue; }

          const graphNode = runtime.getNode(blockId);
          if (!graphNode) { pendingUpgrade.delete(blockId); continue; }

          upgradeBlockContent(block, graphNode.contentAST);
          pendingUpgrade.delete(blockId);
        }
      }, { tag: 'runtime-sync' });
      Promise.resolve().then(() => { isSyncingRef.current = false; });
    }

    /** Cancel the fallback timer if running. */
    function cancelFallback() {
      if (fallbackTimer !== null) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    }

    /**
     * Ensure a fallback timer is ticking. If rIC hasn't upgraded all
     * pending blocks within UPGRADE_FALLBACK_MS, we force the remaining
     * upgrades synchronously so pills are never indefinitely delayed
     * (e.g. during constant scrolling that starves idle callbacks).
     */
    function ensureFallback() {
      if (fallbackTimer !== null || pendingUpgrade.size === 0) return;
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        if (pendingUpgrade.size === 0) return;
        // Force-upgrade all remaining pending blocks.
        runUpgradePass(null);
      }, UPGRADE_FALLBACK_MS);
    }

    /** Phase-2 idle upgrade: replace light content with full AST. */
    function scheduleUpgrade() {
      if (upgradeHandle !== null || pendingUpgrade.size === 0) return;
      // Start the fallback safety net alongside the idle chain.
      ensureFallback();
      upgradeHandle = rIC((deadline) => {
        upgradeHandle = null;
        runUpgradePass(deadline);

        // If there are still pending upgrades, schedule another idle pass.
        if (pendingUpgrade.size > 0) {
          scheduleUpgrade();
        } else {
          cancelFallback();
        }
      });
    }

    const unsubscribe = subscribeToVisibilityChange((newlyVisible, newlyHidden) => {
      // ── Orphan detection ──────────────────────────────────────
      // Check if any visible block is not hydrated and wasn't just
      // delivered in newlyVisible.  This catches every state-machine
      // edge case (cancel-out suppression, stale flush, React
      // batching) by enforcing the invariant:
      //   visible → populated  OR  queued-for-hydration
      const currentVisible = getVisibleBlockIds();
      let needsReconcile = false;
      for (const blockId of currentVisible) {
        if (!isBlockPopulated(blockId) && blockIdToKeyMap.current.has(blockId)) {
          needsReconcile = true;
          break;
        }
      }

      if (newlyVisible.length === 0 && newlyHidden.length === 0 && !needsReconcile) return;

      isSyncingRef.current = true;

      editor.update(() => {
        const runtime = getNodeGraphRuntime();
        const processedIds = new Set<string>();

        // ── Phase 1: light-populate newly visible blocks ───────
        for (const blockId of newlyVisible) {
          processedIds.add(blockId);
          if (isBlockPopulated(blockId)) continue;

          const key = blockIdToKeyMap.current.get(blockId);
          if (!key) continue;
          const block = $getNodeByKey(key);
          if (!$isBlockNode(block)) continue;

          const graphNode = runtime.getNode(blockId);
          if (!graphNode) continue;

          // Clear ZWS placeholder
          const children = block.getChildren();
          for (const child of children) child.remove();

          // Light populate (text only — instant)
          const needsUpgrade = populateBlockContentLight(block, graphNode.contentAST);
          markPopulated(blockId);

          if (needsUpgrade) {
            pendingUpgrade.add(blockId);
          }
        }

        // ── Depopulate newly hidden blocks ─────────────────────
        for (const blockId of newlyHidden) {
          if (!isBlockPopulated(blockId)) continue;

          // Guard: skip if the block is currently visible.
          // The debounced newlyHidden list can be stale — the block
          // may have re-entered _visibleBlockIds after the pending-
          // hidden entry was created.  Depopulating it now would
          // leave a visible block with ZWS content.
          if (currentVisible.has(blockId)) continue;

          // Cancel any pending upgrade for this block
          pendingUpgrade.delete(blockId);

          const key = blockIdToKeyMap.current.get(blockId);
          if (!key) continue;
          const block = $getNodeByKey(key);
          if (!$isBlockNode(block)) continue;

          // Replace content with ZWS placeholder
          const children = block.getChildren();
          for (const child of children) child.remove();
          block.append($createTextNode('\u200B'));
          markDepopulated(blockId);
        }

        // ── Reconciliation: catch orphaned visible blocks ──────
        // Any block that is visible, not populated, and wasn't
        // already handled in the newlyVisible loop is an orphan.
        // Light-hydrate it now to enforce the invariant.
        for (const blockId of currentVisible) {
          if (processedIds.has(blockId)) continue;
          if (isBlockPopulated(blockId)) continue;

          const key = blockIdToKeyMap.current.get(blockId);
          if (!key) continue;
          const block = $getNodeByKey(key);
          if (!$isBlockNode(block)) continue;

          const graphNode = runtime.getNode(blockId);
          if (!graphNode) continue;

          const children = block.getChildren();
          for (const child of children) child.remove();

          const needsUpgrade = populateBlockContentLight(block, graphNode.contentAST);
          markPopulated(blockId);

          if (needsUpgrade) {
            pendingUpgrade.add(blockId);
          }
        }
      }, { tag: 'runtime-sync' });

      Promise.resolve().then(() => { isSyncingRef.current = false; });

      // ── Reveal hydrated blocks ───────────────────────────────
      // Remove `node-block--virtualized` CSS class AFTER the Lexical
      // update so content is in the DOM before the block is revealed.
      // Using rAF ensures DOM reconciliation has completed.
      requestAnimationFrame(() => {
        const vis = getVisibleBlockIds();
        for (const blockId of vis) {
          if (!isBlockPopulated(blockId)) continue;
          const key = blockIdToKeyMap.current.get(blockId);
          if (!key) continue;
          const el = editor.getElementByKey(key);
          if (el?.classList.contains('node-block--virtualized')) {
            el.classList.remove('node-block--virtualized');
            el.style.minHeight = '';
          }
        }
      });

      // Schedule Phase-2 upgrades for blocks that still need pills
      scheduleUpgrade();
    });

    return () => {
      unsubscribe();
      if (upgradeHandle !== null) cIC(upgradeHandle);
      cancelFallback();
      pendingUpgrade.clear();
    };
  }, [editor]);

  // ─── Chunked idle pre-hydration ────────────────────────────
  // After the visible blocks are populated, use chained
  // requestIdleCallback calls to pre-populate adjacent blocks in
  // small chunks (IDLE_CHUNK_SIZE per callback).  Each chunk light-
  // populates text first, then full-populates in the same pass if
  // there's budget remaining.

  useEffect(() => {
    let idleHandle: ReturnType<typeof rIC> | null = null;
    // Shared queue persists across idle continuations so a fast scroll
    // that cancels the first callback doesn't lose the collected list.
    let hydrateQueue: string[] = [];

    /** Process the next chunk of hydrateQueue. */
    function processChunk(deadline: IdleDeadline) {
      idleHandle = null;
      if (hydrateQueue.length === 0) return;

      const runtime = getNodeGraphRuntime();
      let processed = 0;

      isSyncingRef.current = true;
      editor.update(() => {
        while (hydrateQueue.length > 0 && processed < IDLE_CHUNK_SIZE) {
          if (deadline.timeRemaining() < 2) break;

          const blockId = hydrateQueue.shift()!;
          if (isBlockPopulated(blockId)) continue;

          const key = blockIdToKeyMap.current.get(blockId);
          if (!key) continue;
          const block = $getNodeByKey(key);
          if (!$isBlockNode(block)) continue;

          const graphNode = runtime.getNode(blockId);
          if (!graphNode) continue;

          const children = block.getChildren();
          for (const child of children) child.remove();
          populateBlockContent(block, graphNode.contentAST);
          markPopulated(blockId);
          processed++;
        }
      }, { tag: 'runtime-sync' });
      Promise.resolve().then(() => { isSyncingRef.current = false; });

      // Schedule next chunk if there's more work
      if (hydrateQueue.length > 0) {
        idleHandle = rIC(processChunk);
      }
    }

    const unsubscribe = subscribeToVisibilityChange(() => {
      // Cancel any in-flight chunk chain
      if (idleHandle !== null) { cIC(idleHandle); idleHandle = null; }

      // Build ordered list of block IDs in Lexical tree order
      const orderedIds: string[] = [];
      editor.getEditorState().read(() => {
        for (const child of $getRoot().getChildren()) {
          if ($isBlockNode(child)) orderedIds.push(child.getBlockId());
        }
      });

      const visibleIds = getVisibleBlockIds();

      // Find the range of visible indices
      let minIdx = orderedIds.length;
      let maxIdx = -1;
      for (let i = 0; i < orderedIds.length; i++) {
        if (visibleIds.has(orderedIds[i])) {
          if (i < minIdx) minIdx = i;
          if (i > maxIdx) maxIdx = i;
        }
      }
      if (maxIdx < 0) return; // no visible blocks

      // Collect blocks to pre-hydrate (PRE_HYDRATE_COUNT above and below)
      hydrateQueue = [];
      const start = Math.max(0, minIdx - PRE_HYDRATE_COUNT);
      const end = Math.min(orderedIds.length - 1, maxIdx + PRE_HYDRATE_COUNT);
      for (let i = start; i <= end; i++) {
        const id = orderedIds[i];
        if (!isBlockPopulated(id) && !visibleIds.has(id)) {
          hydrateQueue.push(id);
        }
      }

      if (hydrateQueue.length > 0) {
        idleHandle = rIC(processChunk);
      }
    });

    return () => {
      unsubscribe();
      if (idleHandle !== null) cIC(idleHandle);
      hydrateQueue = [];
    };
  }, [editor]);

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
          } else if ($isInlineLinkNode(child)) {
            cursorOffset += 1; // Pills count as 1 character
          } else {
            cursorOffset += child.getTextContent().length;
          }
        }

        event?.preventDefault();

        const runtime = getNodeGraphRuntime();
        const newBlockId = crypto.randomUUID();

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

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Returns true when the AST is null / empty / effectively blank. */
function isEmptyAST(contentAST: ContentAST): boolean {
  if (!contentAST || contentAST.length === 0) return true;
  if (
    contentAST.length === 1 &&
    contentAST[0].children.length === 1 &&
    contentAST[0].children[0].type === 'text' &&
    contentAST[0].children[0].text === ''
  ) return true;
  return false;
}

/**
 * Populate a BlockNode's children from a ContentAST.
 * Full mount: text + pills + formatting in one pass.
 */
function populateBlockContent(block: BlockNode, contentAST: ContentAST): void {
  if (isEmptyAST(contentAST)) {
    block.append($createTextNode('\u200B'));
    return;
  }

  for (const para of contentAST) {
    for (const inline of para.children) {
      appendInlineNode(block, inline, 0);
    }
  }

  // Ensure trailing cursor node after pill / line break
  const children = block.getChildren();
  const lastChild = children[children.length - 1];
  if (lastChild && ($isInlineLinkNode(lastChild) || $isLineBreakNode(lastChild))) {
    block.append($createTextNode('\u200B'));
  }
}

/**
 * Progressive ("light") population — Phase 1.
 *
 * Creates only TextNode and LineBreakNode children, skipping inline links
 * and expensive decorator nodes.  Links are represented as plain
 * text placeholders ("·") so the block has the correct character
 * count and is focusable.
 *
 * Call `upgradeBlockContent()` in a subsequent idle callback to
 * replace placeholders with real InlineLinkNodes.
 *
 * Returns `true` if the AST contains pills that still need upgrading,
 * `false` if the content is fully mounted (no pills).
 */
function populateBlockContentLight(block: BlockNode, contentAST: ContentAST): boolean {
  if (isEmptyAST(contentAST)) {
    block.append($createTextNode('\u200B'));
    return false;
  }

  let hasPills = false;
  for (const para of contentAST) {
    for (const inline of para.children) {
      if (appendInlineNodeLight(block, inline, 0)) hasPills = true;
    }
  }

  // Trailing cursor node
  const children = block.getChildren();
  const lastChild = children[children.length - 1];
  if (lastChild && $isLineBreakNode(lastChild)) {
    block.append($createTextNode('\u200B'));
  }

  return hasPills;
}

/**
 * Phase 1 inline node appender — text-only.
 * Pills become plain ZWS placeholder text nodes.
 */
function appendInlineNodeLight(parent: BlockNode, inline: ASTInlineNode, format: number): boolean {
  let hasPills = false;
  switch (inline.type) {
    case 'text': {
      // Auto-migrate legacy plain-text nodes that contain `backtick` patterns.
      if (/`[^`\n]+`/.test(inline.text)) {
        for (const part of inline.text.split(/(`[^`\n]+`)/)) {
          if (!part) continue;
          if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
            const codeNode = $createTextNode(part.slice(1, -1));
            codeNode.setFormat(format | 16); // IS_CODE
            parent.append(codeNode);
          } else {
            const textNode = $createTextNode(part);
            if (format !== 0) textNode.setFormat(format);
            parent.append(textNode);
          }
        }
      } else {
        const textNode = $createTextNode(inline.text);
        if (format !== 0) textNode.setFormat(format);
        parent.append(textNode);
      }
      break;
    }
    case 'code': {
      const codeNode = $createTextNode(inline.text);
      codeNode.setFormat(format | 16); // IS_CODE
      parent.append(codeNode);
      break;
    }
    case 'hard_break':
      parent.append($createLineBreakNode());
      break;
    case 'node_link':
    case 'external_link':
      // Placeholder — keeps character count stable
      parent.append($createTextNode('\u200B'));
      hasPills = true;
      break;
    case 'strong':
      for (const c of inline.children) { if (appendInlineNodeLight(parent, c, format | 1)) hasPills = true; }
      break;
    case 'em':
      for (const c of inline.children) { if (appendInlineNodeLight(parent, c, format | 2)) hasPills = true; }
      break;
    case 'strikethrough':
      for (const c of inline.children) { if (appendInlineNodeLight(parent, c, format | 4)) hasPills = true; }
      break;
    case 'underline':
      for (const c of inline.children) { if (appendInlineNodeLight(parent, c, format | 8)) hasPills = true; }
      break;
    case 'highlight':
      for (const c of inline.children) { if (appendInlineNodeLight(parent, c, format)) hasPills = true; }
      break;
  }
  return hasPills;
}

/**
 * Collect pill AST nodes (node_link / external_link) from an inline
 * tree in document order, recursing through formatting wrappers.
 */
function collectPillsFromAST(nodes: readonly ASTInlineNode[], out: ASTInlineNode[]): void {
  for (const n of nodes) {
    if (n.type === 'node_link' || n.type === 'external_link') {
      out.push(n);
    } else if ('children' in n && Array.isArray((n as any).children)) {
      collectPillsFromAST((n as any).children, out);
    }
  }
}

/**
 * Phase 2 — upgrade a light-mounted block to full content.
 *
 * Uses **surgical replacement**: only the ZWS placeholder TextNodes
 * that represent pills are swapped for real InlineLinkNodes.  All other
 * children (text, formatting) remain untouched, which means:
 *   - The user's cursor position is preserved.
 *   - No DOM flicker (no clear + repopulate cycle).
 *   - No portal duplication (old TextNodes have no decorators).
 *
 * If the number of ZWS placeholders doesn't match the pill count in
 * the AST (e.g. the block was edited between Phase 1 and Phase 2),
 * we fall back to a full clear + repopulate.
 */
function upgradeBlockContent(block: BlockNode, contentAST: ContentAST): void {
  if (isEmptyAST(contentAST)) return;

  // --- Collect pills from the AST in document order ---
  const pills: ASTInlineNode[] = [];
  for (const para of contentAST) {
    collectPillsFromAST(para.children, pills);
  }
  if (pills.length === 0) return; // Nothing to upgrade

  // --- Find ZWS placeholder TextNodes that correspond to pills ---
  // In light-populated blocks, each pill is a standalone TextNode('\u200B').
  // Other ZWS nodes (trailing cursor helpers) are acceptable extras —
  // we only need at least as many as there are pills.
  const zwsNodes: { node: import('lexical').TextNode; index: number }[] = [];
  const children = block.getChildren();
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if ($isTextNode(child) && child.getTextContent() === '\u200B') {
      zwsNodes.push({ node: child, index: i });
    }
  }

  if (zwsNodes.length < pills.length) {
    // Mismatch — the block was likely edited.  Fall back to full repopulate.
    const allChildren = block.getChildren();
    for (const c of allChildren) c.remove();
    populateBlockContent(block, contentAST);
    return;
  }

  // --- Surgical replacement: 1-to-1 match of pills to ZWS nodes ---
  for (let i = 0; i < pills.length; i++) {
    const astPill = pills[i];
    const { node: zwsNode } = zwsNodes[i];

    // Determine if a pre-pill ZWS cursor node is needed.
    // `appendInlineNode` adds one when the pill would be the first child
    // or immediately follows another InlineLinkNode.
    const prev = zwsNode.getPreviousSibling();
    const needsPreZWS = !prev || $isInlineLinkNode(prev);

    let inlineLink;
    if (astPill.type === 'node_link') {
      inlineLink = $createInlineLinkNode(
        astPill.link_id,
        astPill.ref_type,
        undefined,
        astPill.label ?? undefined,
      );
    } else if (astPill.type === 'external_link') {
      const label = astPill.children
        ?.map((c: ASTInlineNode) => ('text' in c ? (c as any).text : ''))
        .join('') ?? '';
      inlineLink = $createInlineLinkNode(label || astPill.url, 'url', astPill.url);
    } else {
      continue;
    }

    if (needsPreZWS) {
      zwsNode.insertBefore($createTextNode('\u200B'));
    }
    zwsNode.replace(inlineLink);
  }

  // --- Ensure trailing ZWS after last pill / line break ---
  const finalChildren = block.getChildren();
  const last = finalChildren[finalChildren.length - 1];
  if (last && ($isInlineLinkNode(last) || $isLineBreakNode(last))) {
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
      // Auto-migrate legacy plain-text nodes that contain `backtick` patterns.
      if (/`[^`\n]+`/.test(inline.text)) {
        for (const part of inline.text.split(/(`[^`\n]+`)/)) {
          if (!part) continue;
          if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
            const codeNode = $createTextNode(part.slice(1, -1));
            codeNode.setFormat(format | 16); // IS_CODE
            parent.append(codeNode);
          } else {
            const textNode = $createTextNode(part);
            if (format !== 0) textNode.setFormat(format);
            parent.append(textNode);
          }
        }
      } else {
        const textNode = $createTextNode(inline.text);
        if (format !== 0) textNode.setFormat(format);
        parent.append(textNode);
      }
      break;
    }
    case 'code': {
      const codeNode = $createTextNode(inline.text);
      codeNode.setFormat(format | 16); // IS_CODE
      parent.append(codeNode);
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
      if (children.length === 0 || $isInlineLinkNode(lastChild)) {
        parent.append($createTextNode('\u200B'));
      }
      const pill = $createInlineLinkNode(inline.link_id, inline.ref_type, undefined, inline.label ?? undefined);
      parent.append(pill);
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
      // Render as a URL pill
      const label = inline.children
        .map(c => ('text' in c ? c.text : ''))
        .join('');
      const urlPill = $createInlineLinkNode(label || inline.url, 'url', inline.url);
      parent.append(urlPill);
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
    if ($isInlineLinkNode(child)) {
      const rt = child.getRefType();
      if (rt === 'url') {
        // URL pill → external_link AST
        const url = child.getUrl();
        const displayText = child.getLinkId();
        inlines.push({
          type: 'external_link',
          url,
          children: displayText && displayText !== url
            ? [{ type: 'text', text: displayText }]
            : [],
        });
      } else {
        const nodeLink: Record<string, unknown> = {
          type: 'node_link',
          link_id: child.getLinkId(),
          ref_type: rt,
        };
        const pillLabel = child.getLabel();
        if (pillLabel) nodeLink.label = pillLabel;
        inlines.push(nodeLink as ASTInlineNode);
      }
    } else if ($isLineBreakNode(child)) {
      inlines.push({ type: 'hard_break' });
    } else {
      const text = child.getTextContent();
      // Skip zero-width space placeholders from empty blocks
      if (text === '\u200B') continue;
      const format = (child as any).getFormat?.() ?? 0;
      
      // Build the AST node with nested marks
      let node: ASTInlineNode;

      if (format & 16) {
        // IS_CODE — leaf node, backticks stored without delimiters
        node = { type: 'code', text };
      } else {
        node = { type: 'text', text };
        // Apply formatting marks
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
