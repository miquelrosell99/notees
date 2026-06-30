/**
 * RuntimeEventBus — typed event layer over OperationRuntime.
 *
 * OperationRuntime is intentionally generic: it only notifies that something
 * changed. This module subscribes to those notifications, diffs consecutive
 * projected snapshots, and emits the RuntimeEvent vocabulary the UI already
 * understands (nodes_changed, structure_changed, collapse_changed, etc.).
 */

import type { OperationRuntime } from './OperationRuntime';
import { getOperationRuntime } from './runtimeInstance';
import type { GraphNode, MutationIntent, RuntimeEvent, RuntimeEventHandler } from './types';
import type { CoreNode } from './operation';
import { applyIntent as applyIntentOperations } from '@/sync/intents';
import { localSyncEngine } from '@/features/sync/engine/localSyncEngine';
import { graphNodeToCoreNode } from './nodeMapping';

// ─── Global singleton ─────────────────────────────────────────────

let instance: RuntimeEventBus | null = null;

export function getRuntimeEventBus(runtime?: OperationRuntime): RuntimeEventBus {
  if (!instance) {
    instance = new RuntimeEventBus(runtime ?? getOperationRuntime());
  }
  return instance;
}

export function resetRuntimeEventBus(runtime?: OperationRuntime): void {
  instance = new RuntimeEventBus(runtime ?? getOperationRuntime());
}

// ─── Event bus class ──────────────────────────────────────────────

export class RuntimeEventBus {
  private runtime: OperationRuntime;
  private listeners = new Set<RuntimeEventHandler>();
  private blockListeners = new Map<string, Set<RuntimeEventHandler>>();

  private previousProjected = new Map<string, CoreNode>();

  private pendingFlush: number | null = null;
  private pendingChangedBlockIds = new Set<string>();
  private pendingStructureParentIds = new Set<string>();
  private pendingDeleted: { blockId: string }[] = [];
  private pendingCollapseChanged: { blockId: string; collapsed: boolean }[] = [];
  private pendingExpandNeeded: { blockId: string }[] = [];
  private pendingSource?: 'intent' | 'sync' | 'undo' | 'redo';
  private pendingSourceEditorId?: string;

  constructor(runtime: OperationRuntime) {
    this.runtime = runtime;
    this.previousProjected = new Map(runtime.snapshot().projectedNodes);
    runtime.subscribe(() => this.handleRuntimeChange());
  }

  // ─── Mutation wrappers (source tagging) ───────────────────────────

  loadNodes(nodes: GraphNode[]): void {
    this.withSource('sync', () => {
      this.runtime.loadBaseNodes(nodes.map(graphNodeToCoreNode));
    });
  }

  upsertNodes(nodes: GraphNode[]): void {
    this.withSource('sync', () => {
      this.runtime.upsertBaseNodes(nodes.map(graphNodeToCoreNode));
    });
  }

  removeNodes(blockIds: string[]): void {
    this.withSource('sync', () => {
      for (const id of blockIds) {
        this.runtime.removeBaseNode(id);
      }
    });
  }

  async applyIntent(
    intent: MutationIntent,
    options?: { source?: 'intent' | 'undo' | 'redo'; sourceEditorId?: string },
  ): Promise<void> {
    const source = options?.source ?? 'intent';
    await this.withSource(source, options?.sourceEditorId, async () => {
      const operations = applyIntentOperations(this.runtime, intent);
      if (operations.length === 0) return;

      if (isStructuralIntent(intent)) {
        // Structural ops: persist before applying so a crash cannot lose the
        // operation after the UI has already updated.
        await localSyncEngine.prepareStructuralOperations(operations);
        for (const operation of operations) {
          this.runtime.applyOperation(operation);
        }
      } else {
        // Text/content ops: apply immediately for responsive typing, then stage.
        for (const operation of operations) {
          this.runtime.applyOperation(operation);
        }
        localSyncEngine.stageOperationsFireAndForget(operations);
      }
    });
  }

  // ─── Subscription API ─────────────────────────────────────────────

  subscribe(handler: RuntimeEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  subscribeToBlock(blockId: string, handler: RuntimeEventHandler): () => void {
    let set = this.blockListeners.get(blockId);
    if (!set) {
      set = new Set();
      this.blockListeners.set(blockId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.blockListeners.delete(blockId);
    };
  }

  /** Flush any pending coalesced events immediately. */
  flushEvents(): void {
    if (this.pendingFlush !== null) {
      cancelAnimationFrame(this.pendingFlush);
      this.pendingFlush = null;
    }
    this.emitPending();
  }

  // ─── Internals ────────────────────────────────────────────────────

  private withSource(
    source: 'intent' | 'sync' | 'undo' | 'redo',
    sourceEditorId: string | undefined,
    fn: () => void | Promise<void>,
  ): void | Promise<void>;
  private withSource(
    source: 'intent' | 'sync' | 'undo' | 'redo',
    fn: () => void | Promise<void>,
  ): void | Promise<void>;
  private withSource(
    source: 'intent' | 'sync' | 'undo' | 'redo',
    arg2?: string | (() => void | Promise<void>),
    arg3?: () => void | Promise<void>,
  ): void | Promise<void> {
    const sourceEditorId = typeof arg2 === 'string' ? arg2 : undefined;
    const fn = typeof arg2 === 'function' ? arg2 : arg3!;

    const prevSource = this.pendingSource;
    const prevEditorId = this.pendingSourceEditorId;
    this.pendingSource = source;
    if (sourceEditorId !== undefined) this.pendingSourceEditorId = sourceEditorId;

    const finish = () => {
      this.pendingSource = prevSource;
      this.pendingSourceEditorId = prevEditorId;
    };

    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(finish, (error: unknown) => {
        finish();
        throw error;
      });
    }
    finish();
  }

  private handleRuntimeChange(): void {
    const current = this.runtime.snapshot().projectedNodes;
    this.detectChanges(this.previousProjected, current);
    this.previousProjected = new Map(current);
  }

  private detectChanges(
    before: ReadonlyMap<string, CoreNode>,
    after: ReadonlyMap<string, CoreNode>,
  ): void {
    for (const [blockId, afterNode] of after) {
      const beforeNode = before.get(blockId);
      if (!beforeNode || coreNodeChanged(beforeNode, afterNode)) {
        this.pendingChangedBlockIds.add(blockId);
        if (afterNode.parentId) this.pendingStructureParentIds.add(afterNode.parentId);
        if (beforeNode && beforeNode.parentId && beforeNode.parentId !== afterNode.parentId) {
          this.pendingStructureParentIds.add(beforeNode.parentId);
        }
      }

      if (beforeNode && beforeNode.collapsed !== afterNode.collapsed) {
        this.pendingCollapseChanged.push({
          blockId,
          collapsed: afterNode.collapsed,
        });
        if (
          !afterNode.collapsed &&
          afterNode.hasServerChildren &&
          this.runtime.getChildren(blockId).length === 0
        ) {
          this.pendingExpandNeeded.push({ blockId });
        }
      }
    }

    for (const [blockId, beforeNode] of before) {
      if (!after.has(blockId)) {
        this.pendingDeleted.push({ blockId });
        if (beforeNode.parentId) this.pendingStructureParentIds.add(beforeNode.parentId);
      }
    }

    this.scheduleEmit();
  }

  private scheduleEmit(): void {
    if (this.pendingFlush !== null) return;
    this.pendingFlush = requestAnimationFrame(() => {
      this.pendingFlush = null;
      this.emitPending();
    });
  }

  private emitPending(): void {
    const source = this.pendingSource ?? 'sync';
    const sourceEditorId = this.pendingSourceEditorId;
    this.pendingSource = undefined;
    this.pendingSourceEditorId = undefined;

    if (this.pendingChangedBlockIds.size > 0) {
      this.emit({
        type: 'nodes_changed',
        blockIds: [...this.pendingChangedBlockIds],
        source,
        sourceEditorId,
      });
      this.pendingChangedBlockIds.clear();
    }

    if (this.pendingStructureParentIds.size > 0) {
      this.emit({
        type: 'structure_changed',
        parentIds: [...this.pendingStructureParentIds],
        source,
      });
      this.pendingStructureParentIds.clear();
    }

    for (const ev of this.pendingDeleted) {
      this.emit({ type: 'block_deleted', blockId: ev.blockId });
    }
    this.pendingDeleted = [];

    for (const ev of this.pendingCollapseChanged) {
      this.emit({
        type: 'collapse_changed',
        blockId: ev.blockId,
        collapsed: ev.collapsed,
      });
    }
    this.pendingCollapseChanged = [];

    for (const ev of this.pendingExpandNeeded) {
      this.emit({ type: 'expand_children_needed', blockId: ev.blockId });
    }
    this.pendingExpandNeeded = [];
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('[RuntimeEventBus] Event handler error:', e);
      }
    }

    if (event.type === 'nodes_changed') {
      for (const blockId of event.blockIds) {
        const set = this.blockListeners.get(blockId);
        if (set) {
          for (const listener of set) {
            try {
              listener(event);
            } catch (e) {
              console.error('[RuntimeEventBus] Event handler error:', e);
            }
          }
        }
      }
    } else if (event.type === 'structure_changed') {
      for (const [blockId, set] of this.blockListeners) {
        const node = this.runtime.getNode(blockId);
        if (node && event.parentIds.includes(node.parentId ?? '')) {
          for (const listener of set) {
            try {
              listener(event);
            } catch (e) {
              console.error('[RuntimeEventBus] Event handler error:', e);
            }
          }
        }
      }
    } else if (
      event.type === 'block_deleted' ||
      event.type === 'collapse_changed' ||
      event.type === 'expand_children_needed'
    ) {
      const set = this.blockListeners.get(event.blockId);
      if (set) {
        for (const listener of set) {
          try {
            listener(event);
          } catch (e) {
            console.error('[RuntimeEventBus] Event handler error:', e);
          }
        }
      }
    }
  }
}

// ─── Convenience exports over the global runtime ──────────────────

export function loadNodes(nodes: GraphNode[], runtime: OperationRuntime = getOperationRuntime()): void {
  getRuntimeEventBus(runtime).loadNodes(nodes);
}

export function upsertNodes(nodes: GraphNode[], runtime: OperationRuntime = getOperationRuntime()): void {
  getRuntimeEventBus(runtime).upsertNodes(nodes);
}

export function removeNodes(blockIds: string[], runtime: OperationRuntime = getOperationRuntime()): void {
  getRuntimeEventBus(runtime).removeNodes(blockIds);
}

export async function applyRuntimeIntent(
  intent: MutationIntent,
  options?: { source?: 'intent' | 'undo' | 'redo'; sourceEditorId?: string },
  runtime: OperationRuntime = getOperationRuntime(),
): Promise<void> {
  await getRuntimeEventBus(runtime).applyIntent(intent, options);
}

// ─── Helpers ──────────────────────────────────────────────────────

function isStructuralIntent(intent: MutationIntent): boolean {
  switch (intent.type) {
    case 'update_content':
      return false;
    case 'batch':
      // A batch is structural unless every sub-intent is a content update.
      return intent.intents.some(isStructuralIntent);
    default:
      return true;
  }
}

function coreNodeChanged(a: CoreNode, b: CoreNode): boolean {
  return (
    a.name !== b.name ||
    a.icon !== b.icon ||
    a.color !== b.color ||
    a.isDeleted !== b.isDeleted ||
    a.classIds.join(',') !== b.classIds.join(',') ||
    a.parentId !== b.parentId ||
    a.orderIndex !== b.orderIndex ||
    a.contentAST !== b.contentAST ||
    a.collapsed !== b.collapsed ||
    a.nodeType !== b.nodeType ||
    a.calloutType !== b.calloutType ||
    a.taskStatus !== b.taskStatus
  );
}
