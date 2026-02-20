/**
 * DragDropPlugin — Custom mouse-based block drag & drop with ghost preview.
 *
 * Instead of a line indicator the dragged block becomes a floating ghost
 * that follows the cursor (anchored at the bullet). When the ghost is
 * near a valid drop position it snaps into place, giving a live preview
 * of where the block will land. Moving further away un-snaps the ghost
 * so it resumes following the cursor.
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { getDragCoordinator } from '../../runtime/DragCoordinator';

export interface DragDropPluginProps {
  editorId: string;
  readOnly?: boolean;
}

const DRAG_THRESHOLD = 5;

// ─── Helpers ─────────────────────────────────────────────────

function findBlockRow(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  return el.closest('.node-block[data-block-id]') as HTMLElement | null;
}

/**
 * Scan all visible blocks in an editor root and return the best
 * drop target for a given Y coordinate, skipping the dragged block
 * and its descendants.
 */
function findDropTarget(
  rootEl: HTMLElement,
  y: number,
  dragBlockId: string,
): { blockEl: HTMLElement; position: 'before' | 'after' } | null {
  const allBlocks = Array.from(
    rootEl.querySelectorAll<HTMLElement>('.node-block[data-block-id]'),
  ).filter((b) => {
    const id = b.getAttribute('data-block-id');
    if (id === dragBlockId) return false;
    if (b.closest(`.node-block[data-block-id="${dragBlockId}"]`)) return false;
    return true;
  });
  if (allBlocks.length === 0) return null;

  const firstRect = allBlocks[0].getBoundingClientRect();
  if (y < firstRect.top) return { blockEl: allBlocks[0], position: 'before' };

  const lastBlock = allBlocks[allBlocks.length - 1];
  if (y > lastBlock.getBoundingClientRect().bottom)
    return { blockEl: lastBlock, position: 'after' };

  for (const block of allBlocks) {
    const r = block.getBoundingClientRect();
    if (y >= r.top && y <= r.bottom) {
      return {
        blockEl: block,
        position: (y - r.top) / r.height < 0.5 ? 'before' : 'after',
      };
    }
  }

  // Between blocks — nearest center
  let closest = allBlocks[0];
  let closestDist = Infinity;
  for (const block of allBlocks) {
    const r = block.getBoundingClientRect();
    const d = Math.abs(y - (r.top + r.height / 2));
    if (d < closestDist) { closestDist = d; closest = block; }
  }
  const cr = closest.getBoundingClientRect();
  return {
    blockEl: closest,
    position: y < cr.top + cr.height / 2 ? 'before' : 'after',
  };
}

function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Component ───────────────────────────────────────────────

export function DragDropPlugin({ editorId, readOnly }: DragDropPluginProps): null {
  const [editor] = useLexicalComposerContext();
  const ghostRef = useRef<HTMLDivElement | null>(null);

  const dragStateRef = useRef<{
    active: boolean;
    pending: boolean;
    startX: number;
    startY: number;
    blockId: string;
    blockEl: HTMLElement;
    sourceDepth: number;
    ghostText: string;
    /** Offset from cursor to the bullet center in the source block */
    bulletOffsetX: number;
    bulletOffsetY: number;
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

    // ── Mousedown ────────────────────────────────────────────
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const bullet = target.closest('.bullet-wrapper') as HTMLElement | null;
      if (!bullet || target.closest('.bullet-collapse-arrow')) return;

      const blockEl = findBlockRow(bullet);
      if (!blockEl) return;
      const blockId = blockEl.getAttribute('data-block-id');
      if (!blockId) return;

      e.preventDefault();
      e.stopPropagation();

      const depth = parseInt(blockEl.getAttribute('data-depth') || '0', 10);

      // Grab text for the ghost label
      const contentEl = blockEl.querySelector('.node-block-content');
      let ghostText = contentEl?.textContent?.trim() || '';
      if (ghostText.length > 60) ghostText = ghostText.substring(0, 60) + '…';

      // Compute bullet anchor offset from the cursor
      const bulletRect = bullet.getBoundingClientRect();
      const bulletCX = bulletRect.left + bulletRect.width / 2;
      const bulletCY = bulletRect.top + bulletRect.height / 2;

      dragStateRef.current = {
        active: false,
        pending: true,
        startX: e.clientX,
        startY: e.clientY,
        blockId,
        blockEl,
        sourceDepth: depth,
        ghostText,
        bulletOffsetX: bulletCX - e.clientX,
        bulletOffsetY: bulletCY - e.clientY,
        snapped: false,
      };
    };

    // ── Mousemove ────────────────────────────────────────────
    const handleMouseMove = (e: MouseEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      if (!state.pending && !state.active) return;

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

        // Build ghost content
        const ghost = ghostRef.current!;
        ghost.innerHTML =
          '<div class="block-drag-ghost__bullet"></div>' +
          `<div class="block-drag-ghost__content">${escapeHtml(state.ghostText)}</div>`;
        ghost.style.display = 'flex';

        state.blockEl.classList.add('node-block--drag-source');
        document.body.classList.add('notees-dragging-block');
      }

      if (!state.active) return;

      const ghost = ghostRef.current!;
      const coordinator = getDragCoordinator();

      // ── Resolve drop target ──
      let drop: { blockEl: HTMLElement; position: 'before' | 'after' } | null = null;

      // Direct hit on a block
      const hitBlock = findBlockRow(e.target as HTMLElement);
      if (hitBlock) {
        const id = hitBlock.getAttribute('data-block-id');
        if (id && id !== state.blockId && !hitBlock.closest(`.node-block[data-block-id="${state.blockId}"]`)) {
          const r = hitBlock.getBoundingClientRect();
          drop = { blockEl: hitBlock, position: (e.clientY - r.top) / r.height < 0.5 ? 'before' : 'after' };
        }
      }

      // Fallback: scan editor content area (handles empty space, gaps)
      if (!drop) {
        const editorContent =
          (e.target as HTMLElement).closest('.notees-editor-content') as HTMLElement ||
          document.querySelector('.main-content .notees-editor-content') as HTMLElement;
        if (editorContent) {
          drop = findDropTarget(editorContent, e.clientY, state.blockId);
        }
      }

      // ── Position ghost ──
      if (drop) {
        const { blockEl: targetBlock, position } = drop;
        const targetId = targetBlock.getAttribute('data-block-id')!;
        const targetEditorRoot = targetBlock.closest('[data-editor-id]');
        const targetEditorId = targetEditorRoot?.getAttribute('data-editor-id') || editorId;

        coordinator.updateTarget({ blockId: targetId, position, targetEditorId });

        // Compute where the ghost should snap
        const targetRect = targetBlock.getBoundingClientRect();
        const targetBullet = targetBlock.querySelector('.bullet-wrapper');
        const targetBulletRect = targetBullet?.getBoundingClientRect();
        const snapLeft = targetBulletRect ? targetBulletRect.left : targetRect.left;
        const snapWidth = targetRect.right - snapLeft;
        const snapTop = position === 'before' ? targetRect.top : targetRect.bottom;

        // Animate when snapping or moving between snap positions
        if (!state.snapped) {
          ghost.style.transition =
            'top 0.15s ease-out, left 0.15s ease-out, width 0.15s ease-out, opacity 0.15s ease-out';
        }
        ghost.classList.add('block-drag-ghost--snapped');
        ghost.classList.remove('block-drag-ghost--floating');
        ghost.style.top = `${snapTop - 14}px`;
        ghost.style.left = `${snapLeft}px`;
        ghost.style.width = `${snapWidth}px`;
        state.snapped = true;
      } else {
        coordinator.updateTarget(null);

        // Float at cursor, anchored at bullet
        if (state.snapped) {
          ghost.style.transition = 'none'; // instant un-snap
        }
        ghost.classList.remove('block-drag-ghost--snapped');
        ghost.classList.add('block-drag-ghost--floating');
        ghost.style.top = `${e.clientY + state.bulletOffsetY - 14}px`;
        ghost.style.left = `${e.clientX + state.bulletOffsetX - 3}px`;
        ghost.style.width = '';
        state.snapped = false;
      }
    };

    // ── Mouseup ──────────────────────────────────────────────
    const handleMouseUp = () => {
      const state = dragStateRef.current;
      if (!state) return;
      if (state.active) {
        getDragCoordinator().completeDrag();
        cleanup(state);
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
      const ghost = ghostRef.current;
      if (ghost) {
        ghost.style.display = 'none';
        ghost.style.transition = '';
        ghost.style.width = '';
        ghost.className = 'block-drag-ghost';
      }
      state.blockEl.classList.remove('node-block--drag-source');
      document.body.classList.remove('notees-dragging-block');
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
    };
  }, [editor, editorId, readOnly]);

  return null;
}
