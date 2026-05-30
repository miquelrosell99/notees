/**
 * useBlockDragDrop — React hook for block-level drag & drop.
 *
 * Extracted from the legacy DragDropPlugin (which was tied to a single
 * Lexical editor). This version works on any DOM container that contains
 * `.node-block[data-block-id]` elements with `.bullet-wrapper` drag handles.
 *
 * Preserves all original UX:
 * - Ghost preview with multi-drag support
 * - Drop-anchor computation (before / after / child)
 * - Auto-scroll
 * - Touch long-press → drag
 * - Touch long-press without movement → context menu
 */

import { useEffect, useRef, type RefObject } from 'react';
import { getDragCoordinator } from '@/runtime/DragCoordinator';
import type { DropTarget as CoordinatorTarget } from '@/runtime/types';

// ─── Types ────────────────────────────────────────────────────────

interface DropAnchor {
  x: number;
  y: number;
  depth: number;
  target: CoordinatorTarget;
}

interface DragState {
  pending: boolean;
  longPressPending: boolean;
  active: boolean;
  startX: number;
  startY: number;
  blockId: string;
  blockEl: HTMLElement;
  sourceDepth: number;
  ghostText: string;
  snapped: boolean;
  topLevelIds: string[];
}

// ─── Constants ────────────────────────────────────────────────────

const DRAG_THRESHOLD = 5;
const SNAP_DISTANCE = 40;
const AUTO_SCROLL_EDGE = 60;
const AUTO_SCROLL_SPEED = 12;
const LONG_PRESS_MS = 400;
const LONG_PRESS_CANCEL_PX = 10;
const MAX_GHOST_ROWS = 4;

// ─── Helpers ──────────────────────────────────────────────────────

function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function findBlockRow(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  return el.closest('.node-block[data-block-id]') as HTMLElement | null;
}

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
  return (document.scrollingElement as HTMLElement) || document.documentElement;
}

function collectDragSubtreeIds(rootEl: HTMLElement, dragBlockId: string): Set<string> {
  const ids = new Set<string>([dragBlockId]);
  const allBlocks = Array.from(rootEl.querySelectorAll<HTMLElement>('.node-block[data-block-id]'));
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
      if (d <= sourceDepth) break;
      ids.add(id);
    }
  }
  return ids;
}

function getBulletCenterX(blockEl: HTMLElement): number {
  const bullet = blockEl.querySelector(':scope > .block-ui > .bullet-wrapper');
  if (bullet) {
    const r = bullet.getBoundingClientRect();
    return r.left + r.width / 2;
  }
  return blockEl.getBoundingClientRect().left + 16;
}

function collectTopLevelSelectedBlocks(rootEl: HTMLElement): string[] {
  const allBlocks = Array.from(rootEl.querySelectorAll<HTMLElement>('.node-block[data-block-id]'));
  const selectedIds = new Set<string>();
  for (const el of allBlocks) {
    if (
      el.classList.contains('node-block--selected') ||
      el.classList.contains('node-block--selected-child')
    ) {
      const id = el.getAttribute('data-block-id');
      if (id) selectedIds.add(id);
    }
  }
  if (selectedIds.size === 0) return [];

  const ancestorStack: Array<{ depth: number; selected: boolean }> = [];
  const topLevel: string[] = [];

  for (const el of allBlocks) {
    const id = el.getAttribute('data-block-id');
    if (!id) continue;
    const depth = parseInt(el.getAttribute('data-depth') || '0', 10);
    while (ancestorStack.length > 0 && ancestorStack[ancestorStack.length - 1].depth >= depth) {
      ancestorStack.pop();
    }
    const isSelected = selectedIds.has(id);
    const hasSelectedAncestor = ancestorStack.some((a) => a.selected);
    if (isSelected && !hasSelectedAncestor) {
      topLevel.push(id);
    }
    ancestorStack.push({ depth, selected: isSelected });
  }

  return topLevel;
}

function computeDropAnchors(
  rootEl: HTMLElement,
  excludedIds: Set<string>,
  editorId: string,
): DropAnchor[] {
  const allBlockEls = Array.from(
    rootEl.querySelectorAll<HTMLElement>('.node-block[data-block-id]'),
  ).filter((el) => {
    const id = el.getAttribute('data-block-id');
    return id ? !excludedIds.has(id) : true;
  });

  if (allBlockEls.length === 0) return [];

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

  function insideExcludedZone(y: number): boolean {
    return y >= excludedTop && y <= excludedBottom;
  }

  const bulletXByDepth = new Map<number, number>();
  let baseLeft = 0;
  let indentPerLevel = 32;
  for (const el of allBlockEls) {
    const d = parseInt(el.getAttribute('data-depth') || '0', 10);
    if (!bulletXByDepth.has(d)) {
      bulletXByDepth.set(d, getBulletCenterX(el));
    }
  }
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

  function bulletXForDepth(depth: number): number {
    if (bulletXByDepth.has(depth)) return bulletXByDepth.get(depth)!;
    return baseLeft + depth * indentPerLevel;
  }

  const anchors: DropAnchor[] = [];

  function blockInfo(el: HTMLElement) {
    const id = el.getAttribute('data-block-id')!;
    const depth = parseInt(el.getAttribute('data-depth') || '0', 10);
    const rect = el.getBoundingClientRect();
    return { id, depth, rect, el };
  }

  const blocks = allBlockEls.map(blockInfo);

  // Before first block
  {
    const first = blocks[0];
    anchors.push({
      x: bulletXForDepth(first.depth),
      y: first.rect.top - 4,
      depth: first.depth,
      target: { blockId: first.id, position: 'before', targetEditorId: editorId },
    });
  }

  // Between blocks
  for (let i = 0; i < blocks.length; i++) {
    const curr = blocks[i];
    const next = i + 1 < blocks.length ? blocks[i + 1] : null;

    let gapY: number;
    if (next) {
      const rawMid = (curr.rect.bottom + next.rect.top) / 2;
      if (insideExcludedZone(rawMid)) {
        const distToCurrEdge = Math.abs(excludedTop - curr.rect.bottom);
        const distToNextEdge = Math.abs(next.rect.top - excludedBottom);
        gapY = distToCurrEdge <= distToNextEdge ? curr.rect.bottom + 4 : next.rect.top - 4;
      } else {
        gapY = rawMid;
      }
    } else {
      gapY = curr.rect.bottom + 8;
    }

    const hasVisibleChildren = next && next.depth > curr.depth;
    const isCollapsed = curr.el.classList.contains('node-block--collapsed');

    if (!hasVisibleChildren && !isCollapsed) {
      anchors.push({
        x: bulletXForDepth(curr.depth + 1),
        y: gapY,
        depth: curr.depth + 1,
        target: { blockId: curr.id, position: 'child', targetEditorId: editorId },
      });
    }

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
      for (let d = curr.depth; d >= 0; d--) {
        const offsetY = (curr.depth - d) * 6;
        anchors.push({
          x: bulletXForDepth(d),
          y: curr.rect.bottom + 8 + offsetY,
          depth: d,
          target: { blockId: curr.id, position: 'after', targetEditorId: editorId },
        });
      }
    } else if (next.depth < curr.depth) {
      for (let d = curr.depth; d > next.depth; d--) {
        const offsetY = (curr.depth - d) * 4;
        anchors.push({
          x: bulletXForDepth(d),
          y: gapY + offsetY,
          depth: d,
          target: { blockId: curr.id, position: 'after', targetEditorId: editorId },
        });
      }
      anchors.push({
        x: bulletXForDepth(next.depth),
        y: gapY,
        depth: next.depth,
        target: { blockId: next.id, position: 'before', targetEditorId: editorId },
      });
    } else if (next.depth === curr.depth && !hasVisibleChildren) {
      anchors.push({
        x: bulletXForDepth(curr.depth),
        y: gapY,
        depth: curr.depth,
        target: { blockId: next.id, position: 'before', targetEditorId: editorId },
      });
    }
  }

  return anchors.filter((a) => !insideExcludedZone(a.y));
}

function findNearestAnchor(anchors: DropAnchor[], cx: number, cy: number): DropAnchor | null {
  let best: DropAnchor | null = null;
  let bestDist = SNAP_DISTANCE;
  for (const a of anchors) {
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

function buildGhostContent(
  ghost: HTMLDivElement,
  isMultiDrag: boolean,
  topLevelIds: string[],
  ghostText: string,
  sourceRootEl: HTMLElement,
): void {
  if (isMultiDrag) {
    ghost.classList.add('block-drag-ghost--multi');
    const rows: string[] = [];
    const visible = topLevelIds.slice(0, MAX_GHOST_ROWS);
    for (const bid of visible) {
      const blockEl = sourceRootEl.querySelector(
        `.node-block[data-block-id="${bid}"]`,
      ) as HTMLElement | null;
      const text = blockEl?.querySelector('.node-block-content')?.textContent?.trim() || '';
      const short = text.length > 48 ? text.slice(0, 48) + '\u2026' : text || '\u2026';
      rows.push(
        '<div class="block-drag-ghost__row">' +
          '<div class="block-drag-ghost__bullet"></div>' +
          `<div class="block-drag-ghost__content">${escapeHtml(short)}</div>` +
          '</div>',
      );
    }
    if (topLevelIds.length > MAX_GHOST_ROWS) {
      rows.push(
        `<div class="block-drag-ghost__row block-drag-ghost__row--more">\u2026and ${topLevelIds.length - MAX_GHOST_ROWS} more</div>`,
      );
    }
    ghost.innerHTML = rows.join('');
  } else {
    ghost.classList.remove('block-drag-ghost--multi');
    ghost.innerHTML =
      '<div class="block-drag-ghost__bullet"></div>' +
      `<div class="block-drag-ghost__content">${escapeHtml(ghostText)}</div>`;
  }
}

// ─── Hook ─────────────────────────────────────────────────────────

export interface UseBlockDragDropOptions {
  containerRef: RefObject<HTMLElement | null>;
  editorId: string;
  readOnly?: boolean;
}

export function useBlockDragDrop({ containerRef, editorId, readOnly }: UseBlockDragDropOptions): void {
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const anchorsRef = useRef<DropAnchor[]>([]);
  const activeAnchorRef = useRef<DropAnchor | null>(null);
  const lastMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const autoScrollRafRef = useRef<number | null>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const excludedIdsRef = useRef<Set<string>>(new Set());
  const spacerElRef = useRef<{ el: HTMLElement; cls: string } | null>(null);
  const dragStateRef = useRef<DragState | null>(null);

  // Ghost element lifecycle
  useEffect(() => {
    const ghost = document.createElement('div');
    ghost.className = 'block-drag-ghost';
    document.body.appendChild(ghost);
    ghostRef.current = ghost;
    return () => ghost.remove();
  }, []);

  // Main drag effect
  useEffect(() => {
    if (readOnly) return;
    const rootEl = containerRef.current;
    if (!rootEl) return;

    function recomputeAnchors() {
      const allAnchors = computeDropAnchors(rootEl!, excludedIdsRef.current, editorId);
      anchorsRef.current = allAnchors;
    }

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
        ghost.style.top = `${anchor.y}px`;
        applyDropSpacing(anchor);
      } else {
        coordinator.updateTarget(null);
        positionGhostFloat(ghost, cx, cy);
        state.snapped = false;
        activeAnchorRef.current = null;
        clearDropSpacing();
      }
    }

    function applyDropSpacing(anchor: DropAnchor) {
      const { blockId, position } = anchor.target;
      const targetEl = document.querySelector(
        `.node-block[data-block-id="${blockId}"]`,
      ) as HTMLElement | null;
      if (!targetEl) {
        clearDropSpacing();
        return;
      }
      const cls =
        position === 'before'
          ? 'node-block--drop-spacing-before'
          : 'node-block--drop-spacing-after';
      const prev = spacerElRef.current;
      if (prev?.el === targetEl && prev.cls === cls) return;
      prev?.el.classList.remove(prev.cls);
      targetEl.classList.add('node-block--drop-spacing-instant');
      targetEl.classList.add(cls);
      spacerElRef.current = { el: targetEl, cls };
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

    function startAutoScroll() {
      const tick = () => {
        const state = dragStateRef.current;
        if (!state?.active) {
          autoScrollRafRef.current = null;
          return;
        }
        const container = scrollContainerRef.current;
        if (!container) {
          autoScrollRafRef.current = requestAnimationFrame(tick);
          return;
        }
        const rect = container.getBoundingClientRect();
        const my = lastMouseRef.current.y;
        let scrollDelta = 0;
        if (my < rect.top + AUTO_SCROLL_EDGE && container.scrollTop > 0) {
          const proximity = 1 - Math.max(0, my - rect.top) / AUTO_SCROLL_EDGE;
          scrollDelta = -AUTO_SCROLL_SPEED * proximity;
        } else if (
          my > rect.bottom - AUTO_SCROLL_EDGE &&
          container.scrollTop < container.scrollHeight - container.clientHeight
        ) {
          const proximity = 1 - Math.max(0, rect.bottom - my) / AUTO_SCROLL_EDGE;
          scrollDelta = AUTO_SCROLL_SPEED * proximity;
        }
        if (scrollDelta !== 0) {
          container.scrollTop += scrollDelta;
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

    function handleScroll() {
      const state = dragStateRef.current;
      if (!state?.active) return;
      recomputeAnchors();
      updateGhostPosition(lastMouseRef.current.x, lastMouseRef.current.y);
    }

    function cleanup(_state: NonNullable<typeof dragStateRef.current>) {
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
      excludedIdsRef.current.forEach((id) => {
        const el = document.querySelector(`.node-block[data-block-id="${id}"]`);
        el?.classList.remove('node-block--drag-source');
      });
      excludedIdsRef.current = new Set();
      document.body.classList.remove('notees-dragging-block');
      anchorsRef.current = [];
      activeAnchorRef.current = null;
      document.querySelectorAll('.block-selection-card').forEach((el) => el.remove());
    }

    // ── Mouse ────────────────────────────────────────────────────

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const bullet = target.closest('.bullet-wrapper') as HTMLElement | null;
      if (!bullet || target.closest('.bullet-collapse-arrow')) return;
      if (e.shiftKey) return;

      const blockEl = findBlockRow(bullet);
      if (!blockEl) return;
      const blockId = blockEl.getAttribute('data-block-id');
      if (!blockId) return;

      e.preventDefault();
      e.stopPropagation();

      const depth = parseInt(blockEl.getAttribute('data-depth') || '0', 10);
      const isInSelection =
        blockEl.classList.contains('node-block--selected') ||
        blockEl.classList.contains('node-block--selected-child');
      const topLevelIds = isInSelection ? collectTopLevelSelectedBlocks(rootEl) : [];
      const isMultiDrag = topLevelIds.length > 1;

      let ghostText: string;
      if (isMultiDrag) {
        const firstEl = rootEl.querySelector(
          `.node-block[data-block-id="${topLevelIds[0]}"]`,
        ) as HTMLElement | null;
        const firstText = firstEl?.querySelector('.node-block-content')?.textContent?.trim() || '';
        const short = firstText.length > 50 ? firstText.slice(0, 50) + '…' : firstText;
        ghostText = short ? `${short} (+${topLevelIds.length - 1})` : `${topLevelIds.length} blocks`;
      } else {
        const contentEl = blockEl.querySelector('.node-block-content');
        ghostText = contentEl?.textContent?.trim() || '';
        if (ghostText.length > 60) ghostText = ghostText.substring(0, 60) + '…';
      }

      dragStateRef.current = {
        pending: true,
        longPressPending: false,
        active: false,
        startX: e.clientX,
        startY: e.clientY,
        blockId,
        blockEl,
        sourceDepth: depth,
        ghostText,
        snapped: false,
        topLevelIds,
      };
    };

    const handleMouseMove = (e: MouseEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      if (!state.pending && !state.active) return;

      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;

      if (state.pending) {
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
        state.pending = false;
        state.active = true;

        window.getSelection()?.removeAllRanges();
        const isMultiDrag = state.topLevelIds.length > 1;
        getDragCoordinator().startDrag({
          blockId: state.blockId,
          sourceEditorId: editorId,
          sourceDepth: state.sourceDepth,
          ...(isMultiDrag ? { blockIds: state.topLevelIds } : {}),
        });

        scrollContainerRef.current = findScrollableAncestor(rootEl);
        const idsToExclude = isMultiDrag ? state.topLevelIds : [state.blockId];
        const subtreeIds = new Set<string>();
        for (const bid of idsToExclude) {
          collectDragSubtreeIds(rootEl, bid).forEach((id) => subtreeIds.add(id));
        }
        excludedIdsRef.current = subtreeIds;
        recomputeAnchors();
        document.querySelectorAll('.block-selection-card').forEach((el) => el.remove());

        const ghost = ghostRef.current!;
        buildGhostContent(ghost, isMultiDrag, state.topLevelIds, state.ghostText, rootEl);
        ghost.style.display = 'flex';
        positionGhostFloat(ghost, e.clientX, e.clientY);

        subtreeIds.forEach((id) => {
          const el = document.querySelector(`.node-block[data-block-id="${id}"]`);
          el?.classList.add('node-block--drag-source');
        });
        document.body.classList.add('notees-dragging-block');

        const sc = scrollContainerRef.current;
        if (sc) sc.addEventListener('scroll', handleScroll, { passive: true });
        startAutoScroll();
      }

      if (!state.active) return;
      updateGhostPosition(e.clientX, e.clientY);
    };

    const handleMouseUp = (_e: MouseEvent) => {
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

        const suppressClick = (ev: MouseEvent) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        window.addEventListener('click', suppressClick, { capture: true, once: true });
        requestAnimationFrame(() =>
          window.removeEventListener('click', suppressClick, { capture: true }),
        );
      }
      dragStateRef.current = null;
    };

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

    // ── Touch ─────────────────────────────────────────────────────

    let longPressTimer: ReturnType<typeof setTimeout> | null = null;

    function cancelLongPress() {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }

    function activateTouchDrag(state: NonNullable<typeof dragStateRef.current>, x: number, y: number) {
      if (!rootEl) return;
      state.longPressPending = false;
      state.active = true;
      navigator.vibrate?.(30);
      window.getSelection()?.removeAllRanges();

      const isMultiDrag = state.topLevelIds.length > 1;
      getDragCoordinator().startDrag({
        blockId: state.blockId,
        sourceEditorId: editorId,
        sourceDepth: state.sourceDepth,
        ...(isMultiDrag ? { blockIds: state.topLevelIds } : {}),
      });

      scrollContainerRef.current = findScrollableAncestor(rootEl);
      const idsToExclude = isMultiDrag ? state.topLevelIds : [state.blockId];
      const subtreeIds = new Set<string>();
      for (const bid of idsToExclude) {
        collectDragSubtreeIds(rootEl, bid).forEach((id) => subtreeIds.add(id));
      }
      excludedIdsRef.current = subtreeIds;
      recomputeAnchors();
      document.querySelectorAll('.block-selection-card').forEach((el) => el.remove());

      const ghost = ghostRef.current!;
      buildGhostContent(ghost, isMultiDrag, state.topLevelIds, state.ghostText, rootEl);
      ghost.style.display = 'flex';
      positionGhostFloat(ghost, x, y);

      subtreeIds.forEach((id) => {
        const el = document.querySelector(`.node-block[data-block-id="${id}"]`);
        el?.classList.add('node-block--drag-source');
      });
      document.body.classList.add('notees-dragging-block');

      const sc = scrollContainerRef.current;
      if (sc) sc.addEventListener('scroll', handleScroll, { passive: true });
      startAutoScroll();
    }

    function onTouchMoveDrag(e: TouchEvent) {
      const state = dragStateRef.current;
      if (!state) return;
      const touch = e.touches[0];
      lastMouseRef.current = { x: touch.clientX, y: touch.clientY };

      if (state.pending) {
        const dx = touch.clientX - state.startX;
        const dy = touch.clientY - state.startY;
        if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_CANCEL_PX) {
          cancelLongPress();
          document.removeEventListener('touchmove', onTouchMoveDrag);
          document.removeEventListener('touchend', onTouchEndDrag);
          document.removeEventListener('touchcancel', onTouchEndDrag);
          dragStateRef.current = null;
        }
        return;
      }

      if (state.longPressPending) {
        activateTouchDrag(state, touch.clientX, touch.clientY);
        e.preventDefault();
        updateGhostPosition(touch.clientX, touch.clientY);
        return;
      }

      if (state.active) {
        e.preventDefault();
        updateGhostPosition(touch.clientX, touch.clientY);
      }
    }

    function onTouchEndDrag(_e?: TouchEvent) {
      cancelLongPress();
      document.removeEventListener('touchmove', onTouchMoveDrag);
      document.removeEventListener('touchend', onTouchEndDrag);
      document.removeEventListener('touchcancel', onTouchEndDrag);

      const state = dragStateRef.current;
      dragStateRef.current = null;
      if (!state) return;

      if (state.active) {
        const coordinator = getDragCoordinator();
        if (activeAnchorRef.current) {
          coordinator.completeDrag();
        } else {
          coordinator.cancelDrag();
        }
        cleanup(state);
        return;
      }

      if (state.longPressPending) {
        const bulletEl = state.blockEl.querySelector<HTMLElement>('.bullet-wrapper');
        if (bulletEl) {
          bulletEl.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: state.startX,
              clientY: state.startY,
            }),
          );
        }
        return;
      }
    }

    const handleTouchStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      const bullet = target.closest('.bullet-wrapper') as HTMLElement | null;
      if (!bullet || target.closest('.bullet-collapse-arrow')) return;

      const blockEl = findBlockRow(bullet);
      if (!blockEl) return;
      const blockId = blockEl.getAttribute('data-block-id');
      if (!blockId) return;
      if (dragStateRef.current) return;

      const touch = e.touches[0];
      const depth = parseInt(blockEl.getAttribute('data-depth') || '0', 10);
      const isInSelection =
        blockEl.classList.contains('node-block--selected') ||
        blockEl.classList.contains('node-block--selected-child');
      const topLevelIds = isInSelection ? collectTopLevelSelectedBlocks(rootEl) : [];
      const isMultiDrag = topLevelIds.length > 1;

      let ghostText: string;
      if (isMultiDrag) {
        const firstEl = rootEl.querySelector(
          `.node-block[data-block-id="${topLevelIds[0]}"]`,
        ) as HTMLElement | null;
        const firstText = firstEl?.querySelector('.node-block-content')?.textContent?.trim() || '';
        const short = firstText.length > 50 ? firstText.slice(0, 50) + '…' : firstText;
        ghostText = short ? `${short} (+${topLevelIds.length - 1})` : `${topLevelIds.length} blocks`;
      } else {
        const contentEl = blockEl.querySelector('.node-block-content');
        ghostText = contentEl?.textContent?.trim() || '';
        if (ghostText.length > 60) ghostText = ghostText.substring(0, 60) + '…';
      }

      dragStateRef.current = {
        pending: true,
        longPressPending: false,
        active: false,
        startX: touch.clientX,
        startY: touch.clientY,
        blockId,
        blockEl,
        sourceDepth: depth,
        ghostText,
        snapped: false,
        topLevelIds,
      };

      document.addEventListener('touchmove', onTouchMoveDrag, { passive: false });
      document.addEventListener('touchend', onTouchEndDrag, { passive: true });
      document.addEventListener('touchcancel', onTouchEndDrag, { passive: true });

      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        const st = dragStateRef.current;
        if (!st || !st.pending) return;
        st.pending = false;
        st.longPressPending = true;
        navigator.vibrate?.(20);
      }, LONG_PRESS_MS);
    };

    // ── Bind ─────────────────────────────────────────────────────
    rootEl.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);
    rootEl.addEventListener('touchstart', handleTouchStart, { passive: true });

    return () => {
      rootEl.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
      rootEl.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', onTouchMoveDrag);
      document.removeEventListener('touchend', onTouchEndDrag);
      document.removeEventListener('touchcancel', onTouchEndDrag);
      cancelLongPress();
      stopAutoScroll();
    };
  }, [containerRef, editorId, readOnly]);
}
