/**
 * OperationRuntime — pure derived-state engine for the Notees graph.
 *
 * Responsibilities:
 * - Hold base server state (from TanStack Query) as CoreNodes.
 * - Hold pending/local operations.
 * - Compute a projected graph by applying operations to base state.
 * - Expose operations ready for dispatch and report ack/fail/retry.
 *
 * This module has no React, TanStack Query, or API imports.
 */

import type { CoreNode, Operation } from './operation';
import { applyOperation, applyOperations } from './operationReducer';
import { withAcknowledged } from './operation';

export interface OperationRuntimeSnapshot {
  readonly baseNodes: ReadonlyMap<string, CoreNode>;
  readonly projectedNodes: ReadonlyMap<string, CoreNode>;
  readonly operations: readonly Operation[];
  readonly dispatchableOperations: readonly Operation[];
}

export class OperationRuntime {
  private baseNodes = new Map<string, CoreNode>();
  private operations = new Map<string, Operation>();
  private projectedNodes = new Map<string, CoreNode>();
  private listeners = new Set<() => void>();

  /**
   * Replace the entire base state (e.g. when a page query returns fresh data).
   * Existing operations are reapplied on top of the new base.
   *
   * All acknowledged operations are removed: loadBaseNodes means the server
   * state is being replaced wholesale, so any operation whose effect was still
   * waiting for a base-state update is now either reflected in the new base or
   * no longer relevant.
   */
  loadBaseNodes(nodes: readonly CoreNode[]): void {
    this.baseNodes = new Map(nodes.map((node) => [node.blockId, node]));
    this.removeAllAcknowledgedOperations();
    this.recomputeProjection();
  }

  /**
   * Incrementally merge one or more base nodes.
   *
   * Acknowledged operations for blocks that are updated here are removed,
   * because the server state is now authoritative for those blocks. This
   * prevents the transient snap-back that can happen when an operation is
   * acknowledged before the corresponding base-state update arrives.
   */
  upsertBaseNodes(nodes: readonly CoreNode[]): void {
    const updatedBlockIds = new Set<string>();
    for (const node of nodes) {
      this.baseNodes.set(node.blockId, node);
      updatedBlockIds.add(node.blockId);
    }
    this.removeAcknowledgedForBlocks(updatedBlockIds);
    this.recomputeProjection();
  }

  /**
   * Remove a base node (e.g. after a confirmed delete).
   */
  removeBaseNode(blockId: string): void {
    this.baseNodes.delete(blockId);
    this.recomputeProjection();
  }

  /**
   * Remove acknowledged operations for the given block IDs.
   *
   * Called by loadBaseNodes / upsertBaseNodes once server state is known to be
   * authoritative for those blocks.
   */
  private removeAcknowledgedForBlocks(blockIds: Set<string>): void {
    for (const [id, operation] of this.operations) {
      if (operation.state === 'acknowledged' && blockIds.has(operation.blockId)) {
        this.operations.delete(id);
      }
    }
  }

  private removeAllAcknowledgedOperations(): void {
    for (const [id, operation] of this.operations) {
      if (operation.state === 'acknowledged') {
        this.operations.delete(id);
      }
    }
  }

  /**
   * Check whether applying an operation to the current base nodes would be a
   * no-op for the fields the operation touches. If so, the base state already
   * reflects the operation and we can discard it immediately.
   */
  private isOperationEffectInBase(operation: Operation): boolean {
    const baseNode = this.baseNodes.get(operation.blockId);
    if (!baseNode) {
      // A create operation is the only one that can legitimately have no base
      // node; in that case the effect is not yet in base.
      return false;
    }
    const after = applyOperation(this.baseNodes, operation);
    const afterNode = after.get(operation.blockId);
    if (!afterNode) return false;

    const touchedFields = (Object.keys(baseNode) as (keyof CoreNode)[]).filter((field) =>
      operationTouchesField(operation, field),
    );
    return touchedFields.every((field) => {
      const a = baseNode[field];
      const b = afterNode[field];
      // Use JSON comparison for arrays/objects (e.g. contentAST, classIds) because
      // reference equality is too strict when base nodes come from a different
      // source than the operation payload.
      if (typeof a === 'object' && a !== null) {
        return JSON.stringify(a) === JSON.stringify(b);
      }
      return a === b;
    });
  }

  /**
   * Apply a local operation. The projected graph updates immediately.
   */
  applyOperation(operation: Operation): void {
    this.operations.set(operation.id, operation);
    this.recomputeProjection();
  }

  /**
   * Mark an operation as acknowledged by the server.
   *
   * The operation is kept in the acknowledged state rather than removed
   * immediately. Its effect continues to be applied to the projection until the
   * next base-state update confirms it. This closes the gap between "server
   * said OK" and "fresh base nodes arrived", which otherwise can cause a
   * visible snap-back (e.g. an indented block jumping back to its old level
   * for one frame).
   *
   * If the current base state already reflects the operation's effect, the
   * operation is discarded right away.
   */
  acknowledgeOperation(operationId: string): void {
    const operation = this.operations.get(operationId);
    if (!operation) return;
    this.operations.set(operationId, withAcknowledged(operation));

    // When the base state is already up to date we can clean up immediately.
    if (this.isOperationEffectInBase(operation)) {
      this.operations.delete(operationId);
    }

    this.recomputeProjection();
  }

  /**
   * Mark an operation as failed. The caller can later call retryOperation.
   */
  failOperation(operationId: string, error: string): void {
    const operation = this.operations.get(operationId);
    if (!operation) return;
    this.operations.set(operationId, {
      ...operation,
      state: 'failed',
      error,
      retryCount: operation.retryCount + 1,
    });
    this.recomputeProjection();
  }

  /**
   * Move a failed operation back to pending so SyncManager can retry it.
   */
  retryOperation(operationId: string): void {
    const operation = this.operations.get(operationId);
    if (!operation || operation.state !== 'failed') return;
    this.operations.set(operationId, {
      ...operation,
      state: 'pending',
      error: undefined,
    });
    this.recomputeProjection();
  }

  /**
   * Cancel/remove an operation that has not yet been dispatched.
   * Used by undo to remove client-side-only operations.
   */
  cancelOperation(operationId: string): void {
    const operation = this.operations.get(operationId);
    if (!operation || operation.state === 'in_flight') return;
    this.operations.delete(operationId);
    this.recomputeProjection();
  }

  getNode(blockId: string): CoreNode | undefined {
    return this.projectedNodes.get(blockId);
  }

  getChildren(parentId: string | null): CoreNode[] {
    const result: CoreNode[] = [];
    for (const node of this.projectedNodes.values()) {
      if (node.parentId === parentId && !node.isDeleted) {
        result.push(node);
      }
    }
    return result.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  getOperations(): readonly Operation[] {
    return [...this.operations.values()];
  }

  getOperationsForBlock(blockId: string): readonly Operation[] {
    return this.getOperations().filter((op) => op.blockId === blockId);
  }

  getPendingOperations(): readonly Operation[] {
    return this.getOperations().filter((op) => op.state === 'pending');
  }

  getInFlightOperations(): readonly Operation[] {
    return this.getOperations().filter((op) => op.state === 'in_flight');
  }

  /**
   * Operations whose dependencies are all acknowledged and are ready to be
   * dispatched by SyncManager.
   */
  getDispatchableOperations(): readonly Operation[] {
    const pendingAndInFlightIds = new Set(
      this.getOperations()
        .filter((op) => op.state === 'pending' || op.state === 'in_flight')
        .map((op) => op.id),
    );

    return this.getPendingOperations().filter((op) =>
      // A dependency is satisfied if it is no longer active (acknowledged/removed)
      // or if it is somehow still in-flight (should not happen in normal flow).
      op.dependsOn.every((depId) => !pendingAndInFlightIds.has(depId)),
    );
  }

  /**
   * True if any operation is pending or in-flight for the given block and field.
   */
  hasPendingChange(blockId: string, field?: keyof CoreNode): boolean {
    return this.getOperationsForBlock(blockId).some(
      (op) => (op.state === 'pending' || op.state === 'in_flight') &&
        (field === undefined || operationTouchesField(op, field)),
    );
  }

  snapshot(): OperationRuntimeSnapshot {
    return {
      baseNodes: this.baseNodes,
      projectedNodes: this.projectedNodes,
      operations: this.getOperations(),
      dispatchableOperations: this.getDispatchableOperations(),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private recomputeProjection(): void {
    this.projectedNodes = applyOperations(this.baseNodes, this.getOperations());
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function operationTouchesField(operation: Operation, field: keyof CoreNode): boolean {
  switch (operation.type) {
    case 'update_content':
      return field === 'contentAST' || field === 'name';
    case 'move':
      return field === 'parentId' || field === 'orderIndex';
    case 'create':
      return true;
    case 'delete':
      return field === 'isDeleted';
    case 'set_collapsed':
      return field === 'collapsed';
    case 'set_classes':
    case 'add_class':
    case 'remove_class':
      return field === 'classIds';
    case 'set_tags':
    case 'add_tag':
    case 'remove_tag':
      return field === 'tagIds';
    case 'update_node':
      return true;
    case 'move_node':
      return field === 'parentId' || field === 'orderIndex';
    default:
      return false;
  }
}
