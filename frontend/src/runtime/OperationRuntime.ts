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
import { applyOperations } from './operationReducer';

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
   */
  loadBaseNodes(nodes: readonly CoreNode[]): void {
    this.baseNodes = new Map(nodes.map((node) => [node.blockId, node]));
    this.recomputeProjection();
  }

  /**
   * Incrementally merge one or more base nodes.
   */
  upsertBaseNodes(nodes: readonly CoreNode[]): void {
    for (const node of nodes) {
      this.baseNodes.set(node.blockId, node);
    }
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
   * Apply a local operation. The projected graph updates immediately.
   */
  applyOperation(operation: Operation): void {
    this.operations.set(operation.id, operation);
    this.recomputeProjection();
  }

  /**
   * Mark an operation as acknowledged by the server.
   */
  acknowledgeOperation(operationId: string): void {
    const operation = this.operations.get(operationId);
    if (!operation) return;
    this.operations.delete(operationId);
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
      return field === 'classIds';
    case 'set_tags':
      return field === 'tagIds';
    default:
      return false;
  }
}
