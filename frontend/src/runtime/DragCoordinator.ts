/**
 * DragCoordinator — Global coordinator for cross-editor drag & drop.
 *
 * All drag/reparent/reorder operations go through DragCoordinator,
 * which delegates structural mutations to NodeGraphRuntime.
 * Lexical editors never move nodes themselves; they emit drag intents.
 */

import { getNodeGraphRuntime } from './NodeGraphRuntime';
import type { DragPayload, DropTarget, MutationIntent } from './types';

export type DragState =
  | { status: 'idle' }
  | { status: 'dragging'; payload: DragPayload; currentTarget: DropTarget | null }
  | { status: 'completing' };

export type DragEventHandler = (state: DragState) => void;

export class DragCoordinator {
  private state: DragState = { status: 'idle' };
  private listeners = new Set<DragEventHandler>();
  private moveGuard: ((blockId: string, newParentId: string) => boolean) | null = null;

  // ─── Drag lifecycle ───────────────────────────────────────────

  startDrag(payload: DragPayload): void {
    this.state = { status: 'dragging', payload, currentTarget: null };
    this.notify();
  }

  updateTarget(target: DropTarget | null): void {
    if (this.state.status !== 'dragging') return;
    this.state = { ...this.state, currentTarget: target };
    this.notify();
  }

  completeDrag(): void {
    if (this.state.status !== 'dragging' || !this.state.currentTarget) {
      this.cancelDrag();
      return;
    }

    const { payload, currentTarget } = this.state;
    this.state = { status: 'completing' };
    this.notify();

    const runtime = getNodeGraphRuntime();

    // Compute the actual parent and anchor position for the first (or only) block
    let newParentId: string;
    let afterBlockId: string | null;

    switch (currentTarget.position) {
      case 'before': {
        const targetNode = runtime.getNode(currentTarget.blockId);
        newParentId = targetNode?.parentId || '';
        // Find the sibling before the target
        const siblings = runtime.getSiblings(currentTarget.blockId);
        const targetIdx = siblings.findIndex(s => s.blockId === currentTarget.blockId);
        afterBlockId = targetIdx > 0 ? siblings[targetIdx - 1].blockId : null;
        break;
      }
      case 'after': {
        const targetNode = runtime.getNode(currentTarget.blockId);
        newParentId = targetNode?.parentId || '';
        afterBlockId = currentTarget.blockId;
        break;
      }
      case 'child': {
        newParentId = currentTarget.blockId;
        const children = runtime.getChildren(currentTarget.blockId);
        afterBlockId = children.length > 0 ? children[children.length - 1].blockId : null;
        break;
      }
    }

    // Determine the set of top-level blocks being moved (multi or single)
    const blockIds = payload.blockIds && payload.blockIds.length > 1
      ? payload.blockIds
      : [payload.blockId];

    // Prevent any dragged block from being dropped onto itself or its descendants
    for (const blockId of blockIds) {
      const descendants = runtime.getDescendants(blockId);
      const descendantIds = new Set(descendants.map(d => d.blockId));
      if (descendantIds.has(newParentId) || newParentId === blockId) {
        this.cancelDrag();
        return;
      }
    }

    // Check move guard (page boundaries, projection root locking, etc.)
    for (const blockId of blockIds) {
      if (this.moveGuard && !this.moveGuard(blockId, newParentId)) {
        this.cancelDrag();
        return;
      }
    }

    if (blockIds.length === 1) {
      // Single block — existing behaviour
      const intent: MutationIntent = {
        type: 'move_block',
        blockId: blockIds[0],
        newParentId,
        afterBlockId,
      };
      runtime.applyIntent(intent);
    } else {
      // Multi-block — move each top-level block in DOM order, placing each one
      // after the previous so their relative order is preserved.
      const intents: MutationIntent[] = [];
      let afterId = afterBlockId;
      for (const blockId of blockIds) {
        intents.push({ type: 'move_block', blockId, newParentId, afterBlockId: afterId });
        // The next block goes after this one (i.e., after blockId itself, not after
        // its subtree — the runtime treats afterBlockId as a direct-sibling anchor).
        afterId = blockId;
      }
      runtime.applyIntent({ type: 'batch', intents });
    }

    this.state = { status: 'idle' };
    this.notify();
  }

  cancelDrag(): void {
    this.state = { status: 'idle' };
    this.notify();
  }

  // ─── State access ─────────────────────────────────────────────

  getState(): DragState {
    return this.state;
  }

  isDragging(): boolean {
    return this.state.status === 'dragging';
  }

  getDragPayload(): DragPayload | null {
    return this.state.status === 'dragging' ? this.state.payload : null;
  }

  /**
   * Register a move guard function. Called before completing a drag.
   * Return false to cancel the drag operation.
   * Only one guard can be active at a time (last caller wins).
   */
  setMoveGuard(guard: ((blockId: string, newParentId: string) => boolean) | null): void {
    this.moveGuard = guard;
  }

  // ─── Events ───────────────────────────────────────────────────

  subscribe(handler: DragEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (e) {
        console.error('[DragCoordinator] Handler error:', e);
      }
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────

let instance: DragCoordinator | null = null;

export function getDragCoordinator(): DragCoordinator {
  if (!instance) {
    instance = new DragCoordinator();
  }
  return instance;
}
