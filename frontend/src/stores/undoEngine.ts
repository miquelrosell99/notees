/**
 * undoEngine — local undo/redo stack over OperationRuntime.
 *
 * This logic used to live inside the NodeGraphRuntime facade. It is now a
 * standalone module that uses the intent engine and event bus to apply and
 * reverse mutations.
 */

import type { OperationRuntime } from '@/runtime';
import { getOperationRuntime } from '@/runtime';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import { getNode } from '@/runtime/graphHelpers';
import { getContentASTLength } from '@/runtime/astUtils';
import type { MutationIntent, UndoEntry, RuntimeEvent, RuntimeEventHandler, GraphNode } from '@/runtime/types';
import type { RuntimeEventBus } from '@/runtime/eventBus';

// ─── Global singleton ─────────────────────────────────────────────

let instance: UndoEngine | null = null;

export function getUndoEngine(runtime?: OperationRuntime, eventBus?: RuntimeEventBus): UndoEngine {
  if (!instance) {
    instance = new UndoEngine(runtime ?? getOperationRuntime(), eventBus ?? getRuntimeEventBus());
  }
  return instance;
}

export function resetUndoEngine(runtime?: OperationRuntime, eventBus?: RuntimeEventBus): void {
  instance = new UndoEngine(runtime ?? getOperationRuntime(), eventBus ?? getRuntimeEventBus());
}

// ─── Engine ───────────────────────────────────────────────────────

export class UndoEngine {
  private runtime: OperationRuntime;
  private eventBus: RuntimeEventBus;

  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private maxUndoEntries = 100;

  private listeners = new Set<RuntimeEventHandler>();

  constructor(runtime: OperationRuntime, eventBus: RuntimeEventBus) {
    this.runtime = runtime;
    this.eventBus = eventBus;
  }

  // ─── Public API ───────────────────────────────────────────────────

  subscribe(handler: RuntimeEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  applyIntent(
    intent: MutationIntent,
    options?: { pushUndo?: boolean; sourceEditorId?: string },
  ): UndoEntry | null {
    const reverse = this.computeReverse(intent);
    this.eventBus.applyIntent(intent, { source: 'intent', sourceEditorId: options?.sourceEditorId });

    if ((options?.pushUndo ?? true) && reverse) {
      const entry: UndoEntry = {
        forward: intent,
        reverse,
        timestamp: Date.now(),
        label: intentLabel(intent),
      };
      this.undoStack.push(entry);
      if (this.undoStack.length > this.maxUndoEntries) {
        this.undoStack.shift();
      }
      this.redoStack = [];
      this.emit({ type: 'undo_stack_changed' });
      return entry;
    }
    return null;
  }

  undo(): UndoEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.eventBus.applyIntent(entry.reverse, { source: 'undo' });
    this.redoStack.push(entry);
    this.emit({ type: 'undo', entry });
    this.emit({ type: 'undo_stack_changed' });
    return entry;
  }

  redo(): UndoEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.eventBus.applyIntent(entry.forward, { source: 'redo' });
    this.undoStack.push(entry);
    this.emit({ type: 'redo', entry });
    this.emit({ type: 'undo_stack_changed' });
    return entry;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  getUndoStack(): UndoEntry[] {
    return [...this.undoStack];
  }

  getRedoStack(): UndoEntry[] {
    return [...this.redoStack];
  }

  clearUndoRedo(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.emit({ type: 'undo_stack_changed' });
  }

  serializeUndoStacks(): { undo: UndoEntry[]; redo: UndoEntry[] } {
    return { undo: [...this.undoStack], redo: [...this.redoStack] };
  }

  restoreUndoStacks(undo: UndoEntry[], redo: UndoEntry[]): void {
    this.undoStack = [...undo];
    this.redoStack = [...redo];
    this.emit({ type: 'undo_stack_changed' });
  }

  // ─── Reverse-intent computation ───────────────────────────────────

  private computeReverse(intent: MutationIntent): MutationIntent | null {
    switch (intent.type) {
      case 'update_content': {
        const node = this.runtime.getNode(intent.blockId);
        if (!node) return null;
        return { type: 'update_content', blockId: intent.blockId, contentAST: [...node.contentAST] };
      }
      case 'create_block':
        return { type: 'delete_block', blockId: intent.blockId };
      case 'delete_block': {
        const node = this.runtime.getNode(intent.blockId);
        if (!node) return null;
        return {
          type: 'create_block',
          parentId: node.parentId || '',
          afterBlockId: null,
          blockId: intent.blockId,
          contentAST: node.contentAST,
          nodeType: node.nodeType,
        };
      }
      case 'move_block': {
        const node = this.runtime.getNode(intent.blockId);
        if (!node) return null;
        const siblings = node.parentId ? this.runtime.getChildren(node.parentId) : [];
        const myIndex = siblings.findIndex((s) => s.blockId === intent.blockId);
        const afterId = myIndex > 0 ? siblings[myIndex - 1].blockId : null;
        return {
          type: 'move_block',
          blockId: intent.blockId,
          newParentId: node.parentId || '',
          afterBlockId: afterId,
        };
      }
      case 'indent_block':
        return { type: 'outdent_block', blockId: intent.blockId };
      case 'outdent_block':
        return { type: 'indent_block', blockId: intent.blockId };
      case 'move_up':
        return { type: 'move_down', blockId: intent.blockId };
      case 'move_down':
        return { type: 'move_up', blockId: intent.blockId };
      case 'toggle_collapsed':
        return { type: 'toggle_collapsed', blockId: intent.blockId };
      case 'set_collapsed': {
        const node = this.runtime.getNode(intent.blockId);
        if (!node) return null;
        return { type: 'set_collapsed', blockId: intent.blockId, collapsed: node.collapsed };
      }
      case 'set_node_type': {
        const node = getNode(this.runtime, intent.blockId);
        if (!node) return null;
        return { type: 'set_node_type', blockId: intent.blockId, nodeType: node.nodeType };
      }
      case 'add_class':
        return { type: 'remove_class', blockId: intent.blockId, classId: intent.classId };
      case 'remove_class':
        return { type: 'add_class', blockId: intent.blockId, classId: intent.classId };
      case 'add_tag':
        return { type: 'remove_tag', blockId: intent.blockId, tagId: intent.tagId };
      case 'remove_tag':
        return { type: 'add_tag', blockId: intent.blockId, tagId: intent.tagId };
      case 'update_node': {
        const node = this.runtime.getNode(intent.blockId);
        if (!node) return null;
        const reverseUpdates: Partial<GraphNode> = {};
        for (const key of Object.keys(intent.updates) as (keyof GraphNode)[]) {
          const value = node[key];
          if (value !== undefined) {
            (reverseUpdates as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value;
          }
        }
        return { type: 'update_node', blockId: intent.blockId, updates: reverseUpdates };
      }
      case 'move_node': {
        const node = this.runtime.getNode(intent.blockId);
        if (!node) return null;
        const siblings = node.parentId ? this.runtime.getChildren(node.parentId) : [];
        const myIndex = siblings.findIndex((s) => s.blockId === intent.blockId);
        const afterId = myIndex > 0 ? siblings[myIndex - 1].blockId : null;
        return {
          type: 'move_node',
          blockId: intent.blockId,
          parentId: node.parentId ?? null,
          afterBlockId: afterId,
        };
      }
      case 'reorder_blocks': {
        const previousOrder = this.runtime.getChildren(intent.parentId).map((n) => n.blockId);
        return {
          type: 'reorder_blocks',
          parentId: intent.parentId,
          orderedBlockIds: previousOrder,
        };
      }
      case 'split_block': {
        return {
          type: 'merge_blocks',
          sourceBlockId: intent.newBlockId,
          targetBlockId: intent.blockId,
        };
      }
      case 'merge_blocks': {
        const target = this.runtime.getNode(intent.targetBlockId);
        if (!target) return null;
        const mergeOffset = getContentASTLength(target.contentAST);
        return {
          type: 'split_block',
          blockId: intent.targetBlockId,
          atOffset: mergeOffset,
          newBlockId: intent.sourceBlockId,
          forceSibling: true,
        };
      }
      case 'batch': {
        const reverses: MutationIntent[] = [];
        for (const sub of intent.intents) {
          const rev = this.computeReverse(sub);
          if (rev) reverses.unshift(rev);
        }
        return { type: 'batch', intents: reverses };
      }
      default:
        return null;
    }
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('[UndoEngine] Event handler error:', e);
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function intentLabel(intent: MutationIntent): string {
  switch (intent.type) {
    case 'create_block':
      return 'Create block';
    case 'delete_block':
      return 'Delete block';
    case 'move_block':
      return 'Move block';
    case 'indent_block':
      return 'Indent block';
    case 'outdent_block':
      return 'Outdent block';
    case 'move_up':
      return 'Move block up';
    case 'move_down':
      return 'Move block down';
    case 'reorder_blocks':
      return 'Reorder blocks';
    case 'set_node_type':
      return 'Change block type';
    case 'add_class':
      return 'Add class';
    case 'remove_class':
      return 'Remove class';
    case 'add_tag':
      return 'Add tag';
    case 'remove_tag':
      return 'Remove tag';
    case 'update_node':
      return 'Update node';
    case 'move_node':
      return 'Move node';
    case 'split_block':
      return 'Split block';
    case 'merge_blocks':
      return 'Merge blocks';
    case 'update_content':
      return 'Edit content';
    case 'batch': {
      const first = intent.intents[0];
      if (!first) return 'Batch edit';
      const sub = intentLabel(first);
      const rest = intent.intents.length - 1;
      return rest > 0 ? `${sub} (+${rest})` : sub;
    }
    default:
      return 'Edit';
  }
}
