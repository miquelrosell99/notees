/**
 * useBlockDragDrop utilities — types, constants, and DOM helpers
 */

// ─── Types ────────────────────────────────────────────────────────

export interface DropTarget {
  blockId: string;
  position: 'before' | 'after' | 'child';
  targetEditorId?: string;
}

export interface DropAnchor {
  x: number;
  y: number;
  depth: number;
  target: DropTarget;
}

export interface DragState {
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

export const DRAG_THRESHOLD = 5;
export const SNAP_DISTANCE = 40;
export const AUTO_SCROLL_EDGE = 60;
export const AUTO_SCROLL_SPEED = 12;
export const LONG_PRESS_MS = 400;
export const LONG_PRESS_CANCEL_PX = 10;
export const MAX_GHOST_ROWS = 4;

// ─── Helpers ──────────────────────────────────────────────────────

export function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function findBlockRow(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  return el.closest('.node-block[data-block-id]') as HTMLElement | null;
}

export function findScrollableAncestor(el: HTMLElement): HTMLElement | null {
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

export function collectDragSubtreeIds(rootEl: HTMLElement, dragBlockId: string): Set<string> {
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

export function getBulletCenterX(blockEl: HTMLElement): number {
  const bullet = blockEl.querySelector(':scope > .block-ui > .bullet-wrapper');
  if (bullet) {
    const r = bullet.getBoundingClientRect();
    return r.left + r.width / 2;
  }
  return blockEl.getBoundingClientRect().left + 16;
}

export function collectTopLevelSelectedBlocks(rootEl: HTMLElement): string[] {
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
