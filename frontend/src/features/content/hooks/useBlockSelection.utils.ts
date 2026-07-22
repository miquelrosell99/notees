/**
 * useBlockSelection utilities — DOM helpers and types.
 */

import { type RefObject } from 'react';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';

// ─── Types ────────────────────────────────────────────────────────

export interface UseBlockSelectionOptions {
  containerRef: RefObject<HTMLElement | null>;
  blockIds: string[];
  readOnly?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────

export const SELECTION_CLASSES = [
  'node-block--selected',
  'node-block--selected-child',
  'node-block--selected-first',
  'node-block--selected-last',
  'node-block--selected-single',
];

export function clearClasses(rootEl: HTMLElement): void {
  const selector = SELECTION_CLASSES.map((c) => `.${c}`).join(', ');
  rootEl.querySelectorAll(selector).forEach((el) => {
    el.classList.remove(...SELECTION_CLASSES);
    el.querySelectorAll('.bullet-wrapper').forEach((bullet) => {
      bullet.removeAttribute('data-selected');
      bullet.removeAttribute('data-selected-child');
    });
  });
}

export function applyClasses(rootEl: HTMLElement, selectedIds: Set<string>): void {
  clearClasses(rootEl);
  if (selectedIds.size === 0) return;

  const allBlocks = Array.from(rootEl.querySelectorAll<HTMLElement>('.node-block[data-block-id]'));
  // Group selected blocks into contiguous runs
  const selectedEls = allBlocks.filter((el) => {
    const blockId = el.getAttribute('data-block-id');
    return blockId && selectedIds.has(blockId);
  });

  if (selectedEls.length === 0) return;

  // Mark each selected element
  for (const el of selectedEls) {
    // Check if it has a selected parent in the DOM order
    const depth = parseInt(el.getAttribute('data-depth') || '0', 10);
    const idx = allBlocks.indexOf(el);
    let hasSelectedParent = false;
    for (let i = idx - 1; i >= 0; i--) {
      const prev = allBlocks[i];
      const prevDepth = parseInt(prev.getAttribute('data-depth') || '0', 10);
      if (prevDepth < depth) {
        const prevId = prev.getAttribute('data-block-id');
        if (prevId && selectedIds.has(prevId)) {
          hasSelectedParent = true;
        }
        break;
      }
    }
    el.classList.add(hasSelectedParent ? 'node-block--selected-child' : 'node-block--selected');
    el.querySelectorAll('.bullet-wrapper').forEach((bullet) => {
      bullet.setAttribute('data-selected', hasSelectedParent ? 'child' : 'true');
    });
  }

  // Apply first/last/single classes per contiguous run
  let runStart = -1;
  for (let i = 0; i <= selectedEls.length; i++) {
    const inRun = i < selectedEls.length;
    if (inRun && runStart === -1) {
      runStart = i;
    }
    if ((!inRun || i === selectedEls.length) && runStart !== -1) {
      const runLength = i - runStart;
      const first = selectedEls[runStart];
      const last = selectedEls[i - 1];
      if (runLength === 1) {
        first.classList.add('node-block--selected-single');
      } else {
        first.classList.add('node-block--selected-first');
        last.classList.add('node-block--selected-last');
      }
      runStart = -1;
    }
  }

  // Overlay
  updateSelectionOverlay(rootEl, selectedEls);
}

export function updateSelectionOverlay(rootEl: HTMLElement, selectedEls: HTMLElement[]): void {
  const wrapper = rootEl.closest('.notees-editor') as HTMLElement | null;
  if (!wrapper) return;
  wrapper.querySelectorAll('.block-selection-card').forEach((el) => el.remove());
  if (selectedEls.length === 0) return;

  const firstEl = selectedEls[0];
  const lastEl = selectedEls[selectedEls.length - 1];
  const wrapperRect = wrapper.getBoundingClientRect();
  const firstRect = firstEl.getBoundingClientRect();
  const lastRect = lastEl.getBoundingClientRect();
  const parentSelected = selectedEls.find((el) => el.classList.contains('node-block--selected'));
  const parentRect = parentSelected ? parentSelected.getBoundingClientRect() : firstRect;

  const top = firstRect.top - wrapperRect.top + wrapper.scrollTop - 2;
  const left = parentRect.left - wrapperRect.left + wrapper.scrollLeft - 6;
  const height = lastRect.bottom - firstRect.top + 4;

  const overlay = document.createElement('div');
  overlay.className = 'block-selection-card';
  overlay.style.top = `${top}px`;
  overlay.style.left = `${left}px`;
  overlay.style.right = '0';
  overlay.style.height = `${height}px`;
  wrapper.appendChild(overlay);
}

/**
 * Returns the sibling block IDs for `blockId` by querying the worker store.
 *
 * @warning This helper is asynchronous as of the worker-client migration.
 *          Callers must `await` the result; it no longer returns `string[]` synchronously.
 */
export async function getSiblingIds(blockId: string, client?: IWorkspaceStoreClient): Promise<string[]> {
  if (!client) return [];
  const node = await client.query<{ parentId: string | null } | undefined>('getNode', [blockId]);
  const parentId = node?.parentId;
  if (!parentId) return [];
  return client.query<string[]>('getChildren', [parentId]);
}

// ─── Hook ─────────────────────────────────────────────────────────
