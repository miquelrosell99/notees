/**
 * DragCoordinator — Global coordinator for cross-editor drag & drop.
 *
 * All drag/reparent/reorder operations go through DragCoordinator,
 * which delegates structural mutations to the core WorkspaceStore via
 * the per-workspace UndoManager so that moves are automatically recorded
 * as undoable actions.
 */

import type { DragPayload, DropTarget } from '@/runtime/types';
import { getWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import { UndoManager } from '@/core/undo/UndoManager';
import { useUndoStore } from '@/stores';
import type { WorkspaceStore } from '@/core/store';

async function applyCoreMove(workspaceId: string, blockId: string, newParentId: string): Promise<void> {
  const manager = UndoManager.getUndoManager(workspaceId);
  if (!manager) {
    throw new Error(`No UndoManager found for workspace ${workspaceId}`);
  }
  manager.moveNode(blockId, newParentId || null);
}

function getDescendantIds(store: WorkspaceStore, blockId: string): Set<string> {
  const ids = new Set<string>();
  const stack = [blockId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const childId of store.getChildren(current)) {
      ids.add(childId);
      stack.push(childId);
    }
  }
  return ids;
}

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

  async completeDrag(): Promise<void> {
    if (this.state.status !== 'dragging' || !this.state.currentTarget) {
      this.cancelDrag();
      return;
    }

    const { payload, currentTarget } = this.state;

    const workspaceId = useUndoStore.getState().currentWorkspaceId;
    if (!workspaceId) {
      this.cancelDrag();
      return;
    }

    const store = getWorkspaceStore(workspaceId);
    if (!store) {
      this.cancelDrag();
      return;
    }

    this.state = { status: 'completing' };
    this.notify();

    // Compute the target parent. Precise ordering is not supported by the
    // prototype core store; moves append to the end of the target parent.
    let newParentId: string;

    switch (currentTarget.position) {
      case 'before':
      case 'after': {
        const targetNode = store.getNode(currentTarget.blockId);
        newParentId = targetNode?.parentId || '';
        break;
      }
      case 'child': {
        newParentId = currentTarget.blockId;
        break;
      }
    }

    // Determine the set of top-level blocks being moved (multi or single)
    const blockIds = payload.blockIds && payload.blockIds.length > 1
      ? payload.blockIds
      : [payload.blockId];

    // Prevent any dragged block from being dropped onto itself or its descendants
    for (const blockId of blockIds) {
      const descendantIds = getDescendantIds(store, blockId);
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
      await applyCoreMove(workspaceId, blockIds[0], newParentId);
    } else {
      // Multi-block — move each top-level block in DOM order. Because the core
      // store appends moved nodes to the end of the target parent's children,
      // iterating in DOM order preserves the blocks' relative order.
      for (const blockId of blockIds) {
        await applyCoreMove(workspaceId, blockId, newParentId);
      }
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
