/**
 * DragDropPlugin — Custom mouse-based block drag & drop with ghost preview.
 *
 * Drop targets are invisible anchor points computed from the block tree.
 * They live at every position where a bullet *would be* if a block existed
 * there — between siblings, before the first child, after all children, etc.
 *
 * The dragged block turns into a floating ghost that follows the cursor.
 * When the cursor gets close to a drop target the ghost snaps to that
 * position, previewing where the block will land.
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { getDragCoordinator } from '../../runtime/DragCoordinator';
import type { DropTarget as CoordinatorTarget } from '../../runtime/types';

export interface DragDropPluginProps {
  editorId: string;
  readOnly?: boolean;
}

const DRAG_THRESHOLD = 5;
/** Max distance (px) from cursor to a drop target to snap */
const SNAP_DISTANCE = 40;
/** Distance from viewport edge to start auto-scrolling (px) */
const AUTO_SCROLL_EDGE = 60;
/** Max auto-scroll speed (px per frame) */
const AUTO_SCROLL_SPEED = 12;

// ─── Types ───────────────────────────────────────────────────

/** A computed drop target — a phantom insertion point */
interface DropAnchor {
  /** Screen position where the bullet would be */
  x: number;
  y: number;
  /** The depth this insertion would have */
  depth: number;
  /** Coordinator-compatible target info */
  target: CoordinatorTarget;
}

// ─── Helpers ─────────────────────────────────────────────────

function findBlockRow(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  return el.closest('.node-block[data-block-id]') as HTMLElement | null;
}

function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Walk up the DOM to find the nearest scrollable ancestor.
 * Falls back to document.scrollingElement.
 */
function findScrollableAncestor(el: HTMLElement): HTMLElement | null {
  let current = el.parentElement;
  while (current && current !== document.documentElement) {
    const { overflowY } = getComputedStyle(current);
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
    current = current.parentElement;
  }
  // Fallback: maybe the whole page scrolls
  return (document.scrollingElement as HTMLElement) || document.documentElement;
}

/**
 * In a flat block list (all BlockNodes are siblings in the DOM),
 * collect the IDs of a block's descendants by walking forward from
 * the block until we hit a sibling at the same or lesser depth.
 */
function collectDragSubtreeIds(
  rootEl: HTMLElement,
  dragBlockId: string,
): Set<string> {
  const ids = new Set<string>([dragBlockId]);
  const allBlocks = Array.from(
    rootEl.querySelectorAll<HTMLElement>('.node-block[data-block-id]'),
  );
  let foundSource = false;
  let sourceDepth = -1;
  for (const el of allBlocks) {
    const id = el.getAttribute('data-block-id')!;
    if (id === dragBlockId) {
      foundSource = true;
      sourceDepth = parseInt(el.getAttribute('data-depth') || '0', 10);
      continue;
    }
    if (foundSource) {
      const d = parseInt(el.getAttribute('data-depth') || '0', 10);
      if (d <= sourceDepth) break; // no longer a descendant
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Get the bullet center X for a given block element.
 * Falls back to the block's left edge if no bullet found.
 */
function getBulletCenterX(blockEl: HTMLElement): number {
  const bullet = blockEl.querySelector(':scope > .block-ui > .bullet-wrapper');
  if (bullet) {
    const r = bullet.getBoundingClientRect();
    return r.left + r.width / 2;
  }
  return blockEl.getBoundingClientRect().left + 16;
}

/**
 * Compute all drop anchors for a given editor root, excluding
 * the dragged block and its descendants.
 *
 * Walk blocks in DOM order. Between each pair of consecutive visible
 * blocks (prev, curr), we insert anchors at every valid depth level
 * for the gap between them.
 *
 * Rules:
 * 1. Between a parent and its first child → depth = child depth
 *    ("insert as first child")
 * 2. Between siblings → depth = sibling depth ("insert between siblings")
 * 3. When depth decreases (outdent) from prev to curr, one anchor
 *    per depth from prevDepth down to currDepth ("insert after subtree
 *    at each level")
 * 4. After the very last block → one anchor per depth from lastDepth
 *    down to 0 ("append at each level")
 * 5. Before the very first block → depth 0 ("prepend at root level")
 * 6. Below any leaf block → depth+1 ("add as child")
 */
function computeDropAnchors(
  rootEl: HTMLElement,
  excludedIds: Set<string>,
  editorId: string,
): DropAnchor[] {
  // Collect all visible blocks in DOM order, excluding the drag source subtree
  const allBlockEls = Array.from(
    rootEl.querySelectorAll<HTMLElement>('.node-block[data-block-id]'),
  ).filter((el) => {
    const id = el.getAttribute('data-block-id');
    return id ? !excludedIds.has(id) : true;
  });

  if (allBlockEls.length === 0) return [];

  // Compute the bounding box of excluded (dragged) blocks so we can avoid
  // placing anchors inside their visual footprint.
  let excludedTop = Infinity;
  let excludedBottom = -Infinity;
  if (excludedIds.size > 0) {
    const allBlocks = rootEl.querySelectorAll<HTMLElement>('.node-block[data-block-id]');
    for (const el of allBlocks) {
      const id = el.getAttribute('data-block-id');
      if (id && excludedIds.has(id)) {
        const r = el.getBoundingClientRect();
        if (r.top < excludedTop) excludedTop = r.top;
        if (r.bottom > excludedBottom) excludedBottom = r.bottom;
      }
    }
  }

  /** True if a Y coordinate falls within the excluded (dimmed) subtree zone */
  function insideExcludedZone(y: number): boolean {
    return y >= excludedTop && y <= excludedBottom;
  }

  // Compute the bullet X position for each depth level by sampling real blocks.
  // We need this so we can position anchors at depths that may not have a
  // corresponding block at that point, using an inferred indent.
  const bulletXByDepth = new Map<number, number>();
  let baseLeft = 0;
  let indentPerLevel = 32; // fallback
  for (const el of allBlockEls) {
    const d = parseInt(el.getAttribute('data-depth') || '0', 10);
    if (!bulletXByDepth.has(d)) {
      bulletXByDepth.set(d, getBulletCenterX(el));
    }
  }
  // Infer indent per level from two different depths
  const sortedDepths = [...bulletXByDepth.keys()].sort((a, b) => a - b);
  if (sortedDepths.length >= 2) {
    const d0 = sortedDepths[0];
    const d1 = sortedDepths[1];
    indentPerLevel = (bulletXByDepth.get(d1)! - bulletXByDepth.get(d0)!) / (d1 - d0);
  }
  if (bulletXByDepth.has(0)) {
    baseLeft = bulletXByDepth.get(0)!;
  } else if (sortedDepths.length > 0) {
    baseLeft = bulletXByDepth.get(sortedDepths[0])! - sortedDepths[0] * indentPerLevel;
  }

  /** Return the X for a given depth, inferring if needed */
  function bulletXForDepth(depth: number): number {
    if (bulletXByDepth.has(depth)) return bulletXByDepth.get(depth)!;
    return baseLeft + depth * indentPerLevel;
  }

  const anchors: DropAnchor[] = [];

  // Helper: info about a block element
  function blockInfo(el: HTMLElement) {
    const id = el.getAttribute('data-block-id')!;
    const depth = parseInt(el.getAttribute('data-depth') || '0', 10);
    const rect = el.getBoundingClientRect();
    // Check if block has visible children (next sibling in our list is deeper)
    return { id, depth, rect, el };
  }

  const blocks = allBlockEls.map(blockInfo);

  // ── Before the first block: insert at depth 0 ──
  {
    const first = blocks[0];
    anchors.push({
      x: bulletXForDepth(first.depth),
      y: first.rect.top - 4,
      depth: first.depth,
      target: { blockId: first.id, position: 'before', targetEditorId: editorId },
    });
  }

  // ── Between consecutive blocks ──
  for (let i = 0; i < blocks.length; i++) {
    const curr = blocks[i];
    const next = i + 1 < blocks.length ? blocks[i + 1] : null;

    // The Y midpoint of the gap between this block and the next.
    // If excluded (dimmed) blocks sit between curr and next, clamp gravity
    // toward the edges so anchors don't land inside the excluded zone.
    let gapY: number;
    if (next) {
      const rawMid = (curr.rect.bottom + next.rect.top) / 2;
      if (insideExcludedZone(rawMid)) {
        // Use the edge nearest to the non-excluded block
        // e.g. if curr is above the zone → just below curr; if next is below the zone → just above next
        const distToCurrEdge = Math.abs(excludedTop - curr.rect.bottom);
        const distToNextEdge = Math.abs(next.rect.top - excludedBottom);
        gapY = distToCurrEdge <= distToNextEdge
          ? curr.rect.bottom + 4
          : next.rect.top - 4;
      } else {
        gapY = rawMid;
      }
    } else {
      gapY = curr.rect.bottom + 8;
    }

    // Does this block have visible children? (next block is deeper)
    const hasVisibleChildren = next && next.depth > curr.depth;
    // Is this block collapsed? Check DOM
    const isCollapsed = curr.el.classList.contains('node-block--collapsed');

    // Rule 6: If block is a leaf (no visible children and not collapsed),
    // offer "add as child" at depth+1
    if (!hasVisibleChildren && !isCollapsed) {
      anchors.push({
        x: bulletXForDepth(curr.depth + 1),
        y: gapY,
        depth: curr.depth + 1,
        target: { blockId: curr.id, position: 'child', targetEditorId: editorId },
      });
    }

    // Rule 1: If next block is a child of current (deeper), offer
    // "insert as first child" at next's depth (between parent & first child)
    if (hasVisibleChildren && next) {
      const childGapY = (curr.rect.bottom + next.rect.top) / 2;
      anchors.push({
        x: bulletXForDepth(next.depth),
        y: childGapY,
        depth: next.depth,
        target: { blockId: next.id, position: 'before', targetEditorId: editorId },
      });
    }

    if (!next) {
      // ── After the last block: anchors at each depth going up ──
      // Rule 4: from currDepth down to 0
      for (let d = curr.depth; d >= 0; d--) {
        const offsetY = (curr.depth - d) * 6; // slight vertical stagger
        anchors.push({
          x: bulletXForDepth(d),
          y: curr.rect.bottom + 8 + offsetY,
          depth: d,
          target: { blockId: curr.id, position: 'after', targetEditorId: editorId },
        });
      }
    } else if (next.depth < curr.depth) {
      // Rule 3: Depth decreases — "outdent" gap. One anchor per depth
      // from curr.depth down to next.depth (next.depth itself is a
      // regular sibling slot, handled by next iteration's "before")
      for (let d = curr.depth; d > next.depth; d--) {
        const offsetY = (curr.depth - d) * 4;
        anchors.push({
          x: bulletXForDepth(d),
          y: gapY + offsetY,
          depth: d,
          target: { blockId: curr.id, position: 'after', targetEditorId: editorId },
        });
      }
      // Rule 2: sibling at next.depth
      anchors.push({
        x: bulletXForDepth(next.depth),
        y: gapY,
        depth: next.depth,
        target: { blockId: next.id, position: 'before', targetEditorId: editorId },
      });
    } else if (next.depth === curr.depth && !hasVisibleChildren) {
      // Rule 2: same-level sibling
      anchors.push({
        x: bulletXForDepth(curr.depth),
        y: gapY,
        depth: curr.depth,
        target: { blockId: next.id, position: 'before', targetEditorId: editorId },
      });
    }
  }

  // Remove any anchors that still land inside the excluded (dimmed) subtree
  return anchors.filter((a) => !insideExcludedZone(a.y));
}

/**
 * Find the nearest drop anchor to a cursor position.
 * Returns null if all anchors are beyond SNAP_DISTANCE.
 */
function findNearestAnchor(
  anchors: DropAnchor[],
  cx: number,
  cy: number,
): DropAnchor | null {
  let best: DropAnchor | null = null;
  let bestDist = SNAP_DISTANCE;

  for (const a of anchors) {
    // Weight X distance more than Y — horizontal position determines
    // which depth level you're targeting when multiple anchors share
    // the same gap. Y just needs to be roughly in the right gap.
    const dy = Math.abs(cy - a.y);
    const dx = Math.abs(cx - a.x);
    const dist = Math.sqrt(dx * dx * 0.5 + dy * dy);
    if (dist < bestDist) {
      bestDist = dist;
      best = a;
    }
  }
  return best;
}

// ─── Component ───────────────────────────────────────────────

export function DragDropPlugin({ editorId, readOnly }: DragDropPluginProps): null {
  const [editor] = useLexicalComposerContext();
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const anchorsRef = useRef<DropAnchor[]>([]);
  const activeAnchorRef = useRef<DropAnchor | null>(null);
  /** Last known mouse position — needed for scroll-triggered recompute */
  const lastMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  /** Auto-scroll RAF handle */
  const autoScrollRafRef = useRef<number | null>(null);
  /** The scrollable container (.main-content) */
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  /** IDs of the dragged block + all its descendants (excluded from drop targets) */
  const excludedIdsRef = useRef<Set<string>>(new Set());
  /** Element currently showing the drop-spacing animation */
  const spacerElRef = useRef<{ el: HTMLElement; cls: string } | null>(null);

  const dragStateRef = useRef<{
    active: boolean;
    pending: boolean;
    startX: number;
    startY: number;
    blockId: string;
    blockEl: HTMLElement;
    sourceDepth: number;
    ghostText: string;
    snapped: boolean;
  } | null>(null);

  // ─── Ghost element lifecycle ────────────────────────────────

  useEffect(() => {
    const ghost = document.createElement('div');
    ghost.className = 'block-drag-ghost';
    document.body.appendChild(ghost);
    ghostRef.current = ghost;
    return () => ghost.remove();
  }, []);

  // ─── Suppress native drag on bullets ────────────────────────

  useEffect(() => {
    if (readOnly) return;
    const rootEl = editor.getRootElement();
    if (!rootEl) return;
    const suppress = (e: Event) => {
      if ((e.target as HTMLElement).closest('.bullet-wrapper')) e.preventDefault();
    };
    rootEl.addEventListener('dragstart', suppress, true);
    return () => rootEl.removeEventListener('dragstart', suppress, true);
  }, [editor, readOnly]);

  // ─── Mouse-based drag system ────────────────────────────────

  useEffect(() => {
    if (readOnly) return;
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    // ── Recompute anchors from all editors on the page ───────
    function recomputeAnchors() {
      const editorRoots = document.querySelectorAll<HTMLElement>('.notees-editor-content');
      let allAnchors: DropAnchor[] = [];
      editorRoots.forEach((root) => {
        const rootEditorId =
          root.closest('[data-editor-id]')?.getAttribute('data-editor-id') || editorId;
        allAnchors = allAnchors.concat(
          computeDropAnchors(root, excludedIdsRef.current, rootEditorId),
        );
      });
      anchorsRef.current = allAnchors;
    }

    // ── Snap ghost to best anchor or float at cursor ─────────
    function updateGhostPosition(cx: number, cy: number) {
      const state = dragStateRef.current;
      if (!state?.active) return;
      const ghost = ghostRef.current;
      if (!ghost) return;

      const coordinator = getDragCoordinator();
      const anchor = findNearestAnchor(anchorsRef.current, cx, cy);

      if (anchor) {
        coordinator.updateTarget(anchor.target);
        ghost.classList.add('block-drag-ghost--snapped');
        ghost.classList.remove('block-drag-ghost--floating');
        ghost.style.transition = 'none';
        ghost.style.left = `${anchor.x - 11}px`;
        ghost.style.width = '200px';
        state.snapped = true;
        activeAnchorRef.current = anchor;

        // Position ghost at the final gap center — blocks animate apart around it
        ghost.style.top = `${anchor.y}px`;

        // Open drop-spacing gap on the target block
        applyDropSpacing(anchor);
      } else {
        coordinator.updateTarget(null);
        positionGhostFloat(ghost, cx, cy);
        state.snapped = false;
        activeAnchorRef.current = null;
        clearDropSpacing();
      }
    }

    // ── Drop spacing helpers ─────────────────────────────────
    function applyDropSpacing(anchor: DropAnchor) {
      const { blockId, position } = anchor.target;
      const targetEl = document.querySelector(
        `.node-block[data-block-id="${blockId}"]`,
      ) as HTMLElement | null;
      if (!targetEl) { clearDropSpacing(); return; }

      // The drop target itself creates the gap:
      //   'before'        → target gets margin-top  → gap opens above  it
      //   'after'/'child' → target gets margin-bottom → gap opens below it
      const cls = position === 'before'
        ? 'node-block--drop-spacing-before'
        : 'node-block--drop-spacing-after';

      const prev = spacerElRef.current;
      if (prev?.el === targetEl && prev.cls === cls) return; // already set
      prev?.el.classList.remove(prev.cls);
      // Suppress transition on the new element so the gap opens instantly
      targetEl.classList.add('node-block--drop-spacing-instant');
      targetEl.classList.add(cls);
      spacerElRef.current = { el: targetEl, cls };
      // Re-enable transition after the layout has painted (for the closing animation)
      requestAnimationFrame(() => targetEl.classList.remove('node-block--drop-spacing-instant'));
    }

    function clearDropSpacing() {
      const prev = spacerElRef.current;
      if (prev) {
        prev.el.classList.remove(prev.cls, 'node-block--drop-spacing-instant');
        spacerElRef.current = null;
      }
    }

    function positionGhostFloat(ghost: HTMLDivElement, cx: number, cy: number) {
      ghost.style.transition = 'none';
      ghost.classList.remove('block-drag-ghost--snapped');
      ghost.classList.add('block-drag-ghost--floating');
      ghost.style.top = `${cy - 14}px`;
      ghost.style.left = `${cx - 11}px`;
      ghost.style.width = '';
    }

    // ── Auto-scroll loop ─────────────────────────────────────
    function startAutoScroll() {
      const tick = () => {
        const state = dragStateRef.current;
        if (!state?.active) { autoScrollRafRef.current = null; return; }

        const container = scrollContainerRef.current;
        if (!container) { autoScrollRafRef.current = requestAnimationFrame(tick); return; }

        const rect = container.getBoundingClientRect();
        const my = lastMouseRef.current.y;
        let scrollDelta = 0;

        if (my < rect.top + AUTO_SCROLL_EDGE && container.scrollTop > 0) {
          // Near top — scroll up
          const proximity = 1 - Math.max(0, my - rect.top) / AUTO_SCROLL_EDGE;
          scrollDelta = -AUTO_SCROLL_SPEED * proximity;
        } else if (
          my > rect.bottom - AUTO_SCROLL_EDGE &&
          container.scrollTop < container.scrollHeight - container.clientHeight
        ) {
          // Near bottom — scroll down
          const proximity = 1 - Math.max(0, rect.bottom - my) / AUTO_SCROLL_EDGE;
          scrollDelta = AUTO_SCROLL_SPEED * proximity;
        }

        if (scrollDelta !== 0) {
          container.scrollTop += scrollDelta;
          // Anchors shifted — recompute and re-snap
          recomputeAnchors();
          updateGhostPosition(lastMouseRef.current.x, lastMouseRef.current.y);
        }

        autoScrollRafRef.current = requestAnimationFrame(tick);
      };
      autoScrollRafRef.current = requestAnimationFrame(tick);
    }

    function stopAutoScroll() {
      if (autoScrollRafRef.current !== null) {
        cancelAnimationFrame(autoScrollRafRef.current);
        autoScrollRafRef.current = null;
      }
    }

    // ── Scroll handler — recompute anchors when user scrolls ─
    function handleScroll() {
      const state = dragStateRef.current;
      if (!state?.active) return;
      recomputeAnchors();
      updateGhostPosition(lastMouseRef.current.x, lastMouseRef.current.y);
    }

    // ── Mousedown ────────────────────────────────────────────
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const bullet = target.closest('.bullet-wrapper') as HTMLElement | null;
      if (!bullet || target.closest('.bullet-collapse-arrow')) return;

      // Shift+click on bullet = open in sidebar (handled by ContextMenuPlugin's click handler).
      // Don't intercept — let the click event propagate naturally.
      if (e.shiftKey) return;

      const blockEl = findBlockRow(bullet);
      if (!blockEl) return;
      const blockId = blockEl.getAttribute('data-block-id');
      if (!blockId) return;

      e.preventDefault();
      e.stopPropagation();

      const depth = parseInt(blockEl.getAttribute('data-depth') || '0', 10);

      const contentEl = blockEl.querySelector('.node-block-content');
      let ghostText = contentEl?.textContent?.trim() || '';
      if (ghostText.length > 60) ghostText = ghostText.substring(0, 60) + '…';

      dragStateRef.current = {
        active: false,
        pending: true,
        startX: e.clientX,
        startY: e.clientY,
        blockId,
        blockEl,
        sourceDepth: depth,
        ghostText,
        snapped: false,
      };
    };

    // ── Mousemove ────────────────────────────────────────────
    const handleMouseMove = (e: MouseEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      if (!state.pending && !state.active) return;

      lastMouseRef.current = { x: e.clientX, y: e.clientY };

      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;

      // ── Activate after threshold ──
      if (state.pending) {
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
        state.pending = false;
        state.active = true;

        window.getSelection()?.removeAllRanges();
        getDragCoordinator().startDrag({
          blockId: state.blockId,
          sourceEditorId: editorId,
          sourceDepth: state.sourceDepth,
        });

        // Find the scrollable container
        scrollContainerRef.current = findScrollableAncestor(rootEl);

        // Collect the dragged block + all its descendants (flat DOM walk)
        const editorRoots = document.querySelectorAll<HTMLElement>('.notees-editor-content');
        let subtreeIds = new Set<string>();
        editorRoots.forEach((root) => {
          const ids = collectDragSubtreeIds(root, state.blockId);
          ids.forEach((id) => subtreeIds.add(id));
        });
        excludedIdsRef.current = subtreeIds;

        // Compute initial anchors (uses excludedIdsRef)
        recomputeAnchors();

        // Build ghost
        const ghost = ghostRef.current!;
        ghost.innerHTML =
          '<div class="block-drag-ghost__bullet"></div>' +
          `<div class="block-drag-ghost__content">${escapeHtml(state.ghostText)}</div>`;
        ghost.style.display = 'flex';
        positionGhostFloat(ghost, e.clientX, e.clientY);

        // Dim the entire dragged subtree
        subtreeIds.forEach((id) => {
          const el = document.querySelector(`.node-block[data-block-id="${id}"]`);
          el?.classList.add('node-block--drag-source');
        });
        document.body.classList.add('notees-dragging-block');

        // Start listening for scroll events
        const sc = scrollContainerRef.current;
        if (sc) sc.addEventListener('scroll', handleScroll, { passive: true });

        // Start auto-scroll loop
        startAutoScroll();
      }

      if (!state.active) return;

      updateGhostPosition(e.clientX, e.clientY);
    };

    // ── Mouseup ──────────────────────────────────────────────
    const handleMouseUp = (e: MouseEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      if (state.active) {
        const coordinator = getDragCoordinator();
        if (activeAnchorRef.current) {
          coordinator.completeDrag();
        } else {
          coordinator.cancelDrag();
        }
        cleanup(state);

        // Suppress the click event that follows mouseup so the block
        // doesn't open in focused view after a cancelled drag.
        const suppressClick = (ev: MouseEvent) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        window.addEventListener('click', suppressClick, { capture: true, once: true });
        // Safety: remove after a tick in case the click never fires
        requestAnimationFrame(() =>
          window.removeEventListener('click', suppressClick, { capture: true }),
        );
      }
      dragStateRef.current = null;
    };

    // ── Escape ───────────────────────────────────────────────
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const state = dragStateRef.current;
      if (!state) return;
      if (state.active) {
        getDragCoordinator().cancelDrag();
        cleanup(state);
      }
      dragStateRef.current = null;
    };

    function cleanup(state: NonNullable<typeof dragStateRef.current>) {
      stopAutoScroll();

      const sc = scrollContainerRef.current;
      if (sc) sc.removeEventListener('scroll', handleScroll);
      scrollContainerRef.current = null;

      const ghost = ghostRef.current;
      if (ghost) {
        ghost.style.display = 'none';
        ghost.style.transition = '';
        ghost.style.width = '';
        ghost.className = 'block-drag-ghost';
      }
      clearDropSpacing();
      // Remove dim class from entire dragged subtree
      excludedIdsRef.current.forEach((id) => {
        const el = document.querySelector(`.node-block[data-block-id="${id}"]`);
        el?.classList.remove('node-block--drag-source');
      });
      excludedIdsRef.current = new Set();
      document.body.classList.remove('notees-dragging-block');
      anchorsRef.current = [];
      activeAnchorRef.current = null;
    }

    // ── Bind ─────────────────────────────────────────────────
    rootEl.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      rootEl.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
      stopAutoScroll();
    };
  }, [editor, editorId, readOnly]);

  return null;
}
