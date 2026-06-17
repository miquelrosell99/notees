/**
 * useBlockDragDrop anchor computation and ghost rendering
 */

import { getBulletCenterX, escapeHtml, MAX_GHOST_ROWS, SNAP_DISTANCE } from './useBlockDragDrop.utils';
import type { DropAnchor } from './useBlockDragDrop.utils';

export function computeDropAnchors(
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

export function findNearestAnchor(anchors: DropAnchor[], cx: number, cy: number): DropAnchor | null {
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

export function buildGhostContent(
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
