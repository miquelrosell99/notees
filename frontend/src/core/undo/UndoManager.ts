import type { WorkspaceStore, NodeRow } from '@/core/store';
import type { TextCrdt } from '@/core/crdt/text';
import type { UndoEntry, UndoEvent, UndoListener } from './types';

type CreateNodeArgs = Parameters<WorkspaceStore['createNode']>[0];
type SetPropertyArgs = Parameters<WorkspaceStore['setProperty']>[0];
type UnsetPropertyArgs = Parameters<WorkspaceStore['unsetProperty']>[0];

interface CapturedProperty {
  propertyValueId: string;
  schemaId: string;
  index: number;
  value: unknown;
}

interface NodeSnapshot {
  node: NodeRow;
  textState: Uint8Array;
  properties: CapturedProperty[];
}

export class UndoManager {
  private static registry = new Map<string, UndoManager>();
  private store: WorkspaceStore;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private maxEntries = 100;
  private listeners = new Set<UndoListener>();

  constructor(store: WorkspaceStore) {
    this.store = store;
  }

  static getOrCreateUndoManager(workspaceId: string, store: WorkspaceStore): UndoManager {
    let manager = UndoManager.registry.get(workspaceId);
    if (!manager) {
      manager = new UndoManager(store);
      UndoManager.registry.set(workspaceId, manager);
    }
    return manager;
  }

  static getUndoManager(workspaceId: string): UndoManager | undefined {
    return UndoManager.registry.get(workspaceId);
  }

  static removeUndoManager(workspaceId: string): void {
    UndoManager.registry.delete(workspaceId);
  }

  createNode(args: CreateNodeArgs): void {
    this.store.createNode(args);
    const entry: UndoEntry = {
      forward: () => this.store.createNode(args),
      inverse: () => this.store.deleteNode(args.nodeId),
      label: 'Create node',
      timestamp: Date.now(),
    };
    this.push(entry);
  }

  /**
   * Create a block and set its initial text content in a single undoable action.
   * The core store stores plain text, so any formatted AST must be stringified
   * before calling this method.
   */
  createBlock(args: CreateNodeArgs & { content?: string }): void {
    const content = args.content ?? '';
    this.store.createNode(args);
    if (args.parentId !== null) {
      this.store.moveNode(args.nodeId, args.parentId);
    }
    if (content !== '') {
      this.store.updateText(args.nodeId, (text) => text.insert(0, content));
    }
    const entry: UndoEntry = {
      forward: () => {
        this.store.createNode(args);
        if (args.parentId !== null) {
          this.store.moveNode(args.nodeId, args.parentId);
        }
        if (content !== '') {
          this.store.updateText(args.nodeId, (text) => text.insert(0, content));
        }
      },
      inverse: () => this.store.deleteNode(args.nodeId),
      label: 'Create block',
      timestamp: Date.now(),
    };
    this.push(entry);
  }

  updateText(nodeId: string, editor: (text: TextCrdt) => void): void {
    const previousText = this.getNodeText(nodeId);
    this.store.updateText(nodeId, editor);
    const entry: UndoEntry = {
      forward: () => this.store.updateText(nodeId, editor),
      inverse: () => {
        this.store.updateText(nodeId, (text) => {
          const current = text.toPlaintext();
          text.delete(0, current.length);
          text.insert(0, previousText);
        });
      },
      label: 'Edit text',
      timestamp: Date.now(),
    };
    this.push(entry);
  }

  moveNode(nodeId: string, newParentId: string | null): void {
    const oldParentId = this.store.getNode(nodeId)?.parentId ?? null;
    this.store.moveNode(nodeId, newParentId);
    const entry: UndoEntry = {
      forward: () => this.store.moveNode(nodeId, newParentId),
      inverse: () => this.store.moveNode(nodeId, oldParentId),
      label: 'Move node',
      timestamp: Date.now(),
    };
    this.push(entry);
  }

  /**
   * Merge the content of `sourceBlockId` into `targetBlockId` and delete the
   * source. Children of the source are moved to the target.
   *
   * Prototype limitation: inline formatting in the source is flattened to plain
   * text on merge. The undo action restores the source node and its text but
   * does not move its children back (they remain under the target).
   */
  mergeBlocks(sourceBlockId: string, targetBlockId: string): void {
    const sourceSnapshot = this.captureNodeSnapshot(sourceBlockId);
    const sourceText = this.getNodeText(sourceBlockId);
    const targetText = this.getNodeText(targetBlockId);
    const sourceChildren = this.store.getChildren(sourceBlockId);

    this.store.updateText(targetBlockId, (text) => {
      const current = text.toPlaintext();
      text.delete(0, current.length);
      text.insert(0, targetText + sourceText);
    });

    for (const childId of sourceChildren) {
      this.store.moveNode(childId, targetBlockId);
    }

    this.store.deleteNode(sourceBlockId);

    const entry: UndoEntry = {
      forward: () => {
        this.store.updateText(targetBlockId, (text) => {
          const current = text.toPlaintext();
          text.delete(0, current.length);
          text.insert(0, targetText + sourceText);
        });
        for (const childId of sourceChildren) {
          this.store.moveNode(childId, targetBlockId);
        }
        this.store.deleteNode(sourceBlockId);
      },
      inverse: () => {
        this.restoreNodeSnapshot(sourceSnapshot);
        this.store.updateText(targetBlockId, (text) => {
          const current = text.toPlaintext();
          text.delete(0, current.length);
          text.insert(0, targetText);
        });
      },
      label: 'Merge blocks',
      timestamp: Date.now(),
    };
    this.push(entry);
  }

  deleteNode(nodeId: string): void {
    const snapshot = this.captureNodeSnapshot(nodeId);
    this.store.deleteNode(nodeId);
    const entry: UndoEntry = {
      forward: () => this.store.deleteNode(nodeId),
      inverse: () => this.restoreNodeSnapshot(snapshot),
      label: 'Delete node',
      timestamp: Date.now(),
    };
    this.push(entry);
  }

  setProperty(args: SetPropertyArgs): void {
    const previous = this.store.getProperty({
      nodeId: args.nodeId,
      schemaId: args.schemaId,
      index: args.index ?? 0,
    });
    this.store.setProperty(args);
    const entry: UndoEntry = {
      forward: () => this.store.setProperty(args),
      inverse: () => {
        if (previous) {
          this.store.setProperty({
            propertyValueId: args.propertyValueId,
            nodeId: args.nodeId,
            schemaId: args.schemaId,
            index: args.index ?? 0,
            value: JSON.parse(previous.value) as unknown,
          });
        } else {
          this.store.unsetProperty({
            nodeId: args.nodeId,
            schemaId: args.schemaId,
            index: args.index ?? 0,
          });
        }
      },
      label: 'Set property',
      timestamp: Date.now(),
    };
    this.push(entry);
  }

  unsetProperty(args: UnsetPropertyArgs): void {
    const previous = this.store.getProperties(args.nodeId).find(
      (p) => p.schemaId === args.schemaId && p.index === (args.index ?? 0)
    );
    this.store.unsetProperty(args);
    const entry: UndoEntry = {
      forward: () => this.store.unsetProperty(args),
      inverse: () => {
        if (previous) {
          this.store.setProperty({
            propertyValueId: previous.propertyValueId,
            nodeId: args.nodeId,
            schemaId: args.schemaId,
            index: args.index ?? 0,
            value: previous.value,
          });
        }
      },
      label: 'Unset property',
      timestamp: Date.now(),
    };
    this.push(entry);
  }

  assignClass(nodeId: string, classId: string): void {
    this.store.assignClass(nodeId, classId);
    const entry: UndoEntry = {
      forward: () => this.store.assignClass(nodeId, classId),
      inverse: () => this.store.unassignClass(nodeId, classId),
      label: 'Assign class',
      timestamp: Date.now(),
    };
    this.push(entry);
  }

  unassignClass(nodeId: string, classId: string): void {
    this.store.unassignClass(nodeId, classId);
    const entry: UndoEntry = {
      forward: () => this.store.unassignClass(nodeId, classId),
      inverse: () => this.store.assignClass(nodeId, classId),
      label: 'Unassign class',
      timestamp: Date.now(),
    };
    this.push(entry);
  }

  undo(): UndoEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    entry.inverse();
    this.redoStack.push(entry);
    this.emit({ type: 'undo', entry });
    return entry;
  }

  redo(): UndoEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    entry.forward();
    this.undoStack.push(entry);
    this.emit({ type: 'redo', entry });
    return entry;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.emit({ type: 'stack_changed' });
  }

  subscribe(listener: UndoListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStacks(): { undo: UndoEntry[]; redo: UndoEntry[] } {
    return { undo: [...this.undoStack], redo: [...this.redoStack] };
  }

  private push(entry: UndoEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxEntries) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.emit({ type: 'stack_changed' });
  }

  private emit(event: UndoEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('UndoManager listener error:', err);
      }
    }
  }

  private getNodeText(nodeId: string): string {
    const node = this.store.getNode(nodeId);
    if (!node) return '';
    try {
      const ast = JSON.parse(node.content) as Array<{ text?: string }>;
      return ast.map((part) => part.text ?? '').join('');
    } catch {
      return '';
    }
  }

  private captureNodeSnapshot(nodeId: string): NodeSnapshot | null {
    const node = this.store.getNode(nodeId);
    if (!node) return null;
    return {
      node,
      textState: this.store.getTextState(nodeId),
      properties: this.store.getProperties(nodeId),
    };
  }

  private restoreNodeSnapshot(snapshot: NodeSnapshot | null): void {
    if (!snapshot) return;
    const { node, properties } = snapshot;

    this.store.createNode({
      nodeId: node.id,
      kind: node.kind,
      parentId: node.parentId,
      classIds: node.classIds,
    });

    this.store.updateText(node.id, (text) => {
      text.applyUpdate(snapshot.textState);
    });

    for (const prop of properties) {
      this.store.setProperty({
        propertyValueId: prop.propertyValueId,
        nodeId: node.id,
        schemaId: prop.schemaId,
        index: prop.index,
        value: prop.value,
      });
    }

    if (node.parentId !== null) {
      this.store.moveNode(node.id, node.parentId);
    }
  }
}
