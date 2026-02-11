/**
 * NodeGraphRuntime — Central authoritative runtime for all nodes.
 *
 * This is the single source of truth for node hierarchy, ordering,
 * content, and metadata. Lexical editors are projections of this runtime.
 *
 * Responsibilities:
 * - Manages all GraphNodes in memory
 * - Handles all structural mutations (move, reparent, reorder, indent/outdent)
 * - Maintains global undo/redo stack
 * - Emits events for projection invalidation
 * - Coordinates with backend API for persistence
 */

import type {
  GraphNode,
  GraphNodeType,
  ContentAST,
  MutationIntent,
  UndoEntry,
  RuntimeEvent,
  RuntimeEventHandler,
  ProjectedNode,
  ProjectionQuery,
} from './types';

// ─── Runtime class ────────────────────────────────────────────────

export class NodeGraphRuntime {
  /** All nodes indexed by blockId */
  private nodes = new Map<string, GraphNode>();

  /** Children indexed by parentId → ordered blockIds */
  private childrenIndex = new Map<string, string[]>();

  /** Undo stack */
  private undoStack: UndoEntry[] = [];
  /** Redo stack */
  private redoStack: UndoEntry[] = [];
  /** Max undo entries */
  private maxUndoEntries = 100;

  /** Event listeners */
  private listeners = new Set<RuntimeEventHandler>();

  /** Pending batch for coalescing rapid edits */
  private pendingFlush: number | null = null;
  private pendingChangedBlockIds = new Set<string>();
  private pendingStructureParentIds = new Set<string>();

  // ─── Initialization ───────────────────────────────────────────

  /**
   * Load nodes from the backend into the runtime.
   * This replaces all current state.
   */
  loadNodes(nodes: GraphNode[]): void {
    this.nodes.clear();
    this.childrenIndex.clear();

    for (const node of nodes) {
      this.nodes.set(node.blockId, node);
    }

    this.rebuildChildrenIndex();
    this.emit({ type: 'structure_changed', parentIds: ['__root__'] });
  }

  /**
   * Incrementally update/add nodes from the backend.
   */
  upsertNodes(nodes: GraphNode[]): void {
    const changedParents = new Set<string>();

    for (const node of nodes) {
      const existing = this.nodes.get(node.blockId);
      if (existing && existing.parentId !== node.parentId) {
        // Parent changed — mark both old and new parent
        if (existing.parentId) changedParents.add(existing.parentId);
        if (node.parentId) changedParents.add(node.parentId);
      } else if (node.parentId) {
        changedParents.add(node.parentId);
      }
      this.nodes.set(node.blockId, node);
    }

    this.rebuildChildrenIndex();

    if (changedParents.size > 0) {
      this.emit({ type: 'structure_changed', parentIds: [...changedParents] });
    }
    this.emit({ type: 'nodes_changed', blockIds: nodes.map(n => n.blockId) });
  }

  /**
   * Remove nodes from the runtime.
   */
  removeNodes(blockIds: string[]): void {
    const parentIds = new Set<string>();
    for (const id of blockIds) {
      const node = this.nodes.get(id);
      if (node?.parentId) parentIds.add(node.parentId);
      this.nodes.delete(id);
    }
    this.rebuildChildrenIndex();
    if (parentIds.size > 0) {
      this.emit({ type: 'structure_changed', parentIds: [...parentIds] });
    }
  }

  // ─── Node access ──────────────────────────────────────────────

  getNode(blockId: string): GraphNode | undefined {
    return this.nodes.get(blockId);
  }

  getChildren(parentId: string): GraphNode[] {
    const childIds = this.childrenIndex.get(parentId) || [];
    return childIds
      .map(id => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  getDescendants(blockId: string): GraphNode[] {
    const result: GraphNode[] = [];
    const stack = [blockId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const children = this.getChildren(current);
      for (const child of children) {
        result.push(child);
        stack.push(child.blockId);
      }
    }
    return result;
  }

  getAncestors(blockId: string): GraphNode[] {
    const result: GraphNode[] = [];
    let current = this.nodes.get(blockId);
    while (current?.parentId) {
      const parent = this.nodes.get(current.parentId);
      if (!parent) break;
      result.push(parent);
      current = parent;
    }
    return result;
  }

  getSiblings(blockId: string): GraphNode[] {
    const node = this.nodes.get(blockId);
    if (!node?.parentId) return [];
    return this.getChildren(node.parentId);
  }

  getAllPages(): GraphNode[] {
    return [...this.nodes.values()].filter(n => n.isPage && !n.isDeleted);
  }

  getAllNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  // ─── Mutations ────────────────────────────────────────────────

  /**
   * Apply a mutation intent. This is the main entry point for all modifications.
   * Returns the undo entry if applicable.
   */
  applyIntent(intent: MutationIntent, pushUndo = true): UndoEntry | null {
    const reverse = this.computeReverse(intent);
    this.executeIntent(intent);

    if (pushUndo && reverse) {
      const entry: UndoEntry = {
        forward: intent,
        reverse,
        timestamp: Date.now(),
      };
      this.undoStack.push(entry);
      if (this.undoStack.length > this.maxUndoEntries) {
        this.undoStack.shift();
      }
      this.redoStack = []; // Clear redo on new action
      return entry;
    }
    return null;
  }

  private executeIntent(intent: MutationIntent): void {
    switch (intent.type) {
      case 'update_content':
        this.execUpdateContent(intent.blockId, intent.contentAST);
        break;
      case 'split_block':
        this.execSplitBlock(intent.blockId, intent.atOffset, intent.newBlockId);
        break;
      case 'merge_blocks':
        this.execMergeBlocks(intent.sourceBlockId, intent.targetBlockId);
        break;
      case 'create_block':
        this.execCreateBlock(intent.parentId, intent.afterBlockId, intent.blockId, intent.contentAST, intent.nodeType);
        break;
      case 'delete_block':
        this.execDeleteBlock(intent.blockId);
        break;
      case 'move_block':
        this.execMoveBlock(intent.blockId, intent.newParentId, intent.afterBlockId);
        break;
      case 'indent_block':
        this.execIndent(intent.blockId);
        break;
      case 'outdent_block':
        this.execOutdent(intent.blockId);
        break;
      case 'toggle_collapsed':
        this.execToggleCollapsed(intent.blockId);
        break;
      case 'set_collapsed':
        this.execSetCollapsed(intent.blockId, intent.collapsed);
        break;
      case 'reorder_blocks':
        this.execReorder(intent.parentId, intent.orderedBlockIds);
        break;
      case 'set_node_type':
        this.execSetNodeType(intent.blockId, intent.nodeType);
        break;
      case 'batch':
        for (const sub of intent.intents) {
          this.executeIntent(sub);
        }
        break;
    }
  }

  // ─── Mutation implementations ─────────────────────────────────

  private execUpdateContent(blockId: string, contentAST: ContentAST): void {
    const node = this.nodes.get(blockId);
    if (!node) return;
    node.contentAST = contentAST;
    node.updatedAt = new Date().toISOString();
    this.scheduleEmit(blockId, null);
  }

  private execSplitBlock(blockId: string, atOffset: number, newBlockId: string): void {
    const node = this.nodes.get(blockId);
    if (!node) return;

    // Split contentAST at offset
    const { before, after } = splitContentASTAtOffset(node.contentAST, atOffset);

    // Update existing node with content before split
    node.contentAST = before;
    node.updatedAt = new Date().toISOString();

    // Create new node with content after split
    const parentId = node.parentId;
    const siblings = parentId ? (this.childrenIndex.get(parentId) || []) : [];
    const myIndex = siblings.indexOf(blockId);
    const orderIndex = myIndex >= 0 ? myIndex + 1 : siblings.length;

    const newNode: GraphNode = {
      blockId: newBlockId,
      parentId,
      orderIndex,
      nodeType: 'block',
      contentAST: after,
      collapsed: false,
      isDeleted: false,
      isPage: false,
      classIds: [],
      tagIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    this.nodes.set(newBlockId, newNode);
    this.rebuildChildrenIndex();
    this.scheduleEmit(blockId, parentId);
    this.scheduleEmit(newBlockId, null);
  }

  private execMergeBlocks(sourceBlockId: string, targetBlockId: string): void {
    const source = this.nodes.get(sourceBlockId);
    const target = this.nodes.get(targetBlockId);
    if (!source || !target) return;

    // Append source content to target
    target.contentAST = mergeContentASTs(target.contentAST, source.contentAST);
    target.updatedAt = new Date().toISOString();

    // Move source's children to target
    const sourceChildren = this.getChildren(sourceBlockId);
    for (const child of sourceChildren) {
      child.parentId = targetBlockId;
    }

    // Remove source
    const parentId = source.parentId;
    this.nodes.delete(sourceBlockId);
    this.rebuildChildrenIndex();
    this.scheduleEmit(targetBlockId, parentId);
  }

  private execCreateBlock(
    parentId: string,
    afterBlockId: string | null,
    blockId: string,
    contentAST: ContentAST,
    nodeType?: GraphNodeType,
  ): void {
    const siblings = this.childrenIndex.get(parentId) || [];
    let orderIndex: number;

    if (afterBlockId) {
      const afterIndex = siblings.indexOf(afterBlockId);
      orderIndex = afterIndex >= 0 ? afterIndex + 1 : siblings.length;
    } else {
      orderIndex = 0;
    }

    // Shift subsequent siblings
    for (let i = orderIndex; i < siblings.length; i++) {
      const sib = this.nodes.get(siblings[i]);
      if (sib) sib.orderIndex = i + 1;
    }

    const newNode: GraphNode = {
      blockId,
      parentId,
      orderIndex,
      nodeType: nodeType || 'block',
      contentAST,
      collapsed: false,
      isDeleted: false,
      isPage: false,
      classIds: [],
      tagIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    this.nodes.set(blockId, newNode);
    this.rebuildChildrenIndex();
    this.scheduleEmit(blockId, parentId);
  }

  private execDeleteBlock(blockId: string): void {
    const node = this.nodes.get(blockId);
    if (!node) return;

    // Recursively delete descendants
    const descendants = this.getDescendants(blockId);
    for (const desc of descendants) {
      this.nodes.delete(desc.blockId);
    }

    const parentId = node.parentId;
    this.nodes.delete(blockId);
    this.rebuildChildrenIndex();
    this.scheduleEmit(blockId, parentId);
  }

  private execMoveBlock(blockId: string, newParentId: string, afterBlockId: string | null): void {
    const node = this.nodes.get(blockId);
    if (!node) return;

    const oldParentId = node.parentId;
    node.parentId = newParentId;

    // Calculate new order
    const newSiblings = this.childrenIndex.get(newParentId) || [];
    if (afterBlockId) {
      const afterIdx = newSiblings.indexOf(afterBlockId);
      node.orderIndex = afterIdx >= 0 ? afterIdx + 1 : newSiblings.length;
    } else {
      node.orderIndex = 0;
    }

    node.updatedAt = new Date().toISOString();
    this.rebuildChildrenIndex();
    this.scheduleEmit(blockId, oldParentId);
    if (newParentId !== oldParentId) {
      this.scheduleEmit(blockId, newParentId);
    }
  }

  private execIndent(blockId: string): void {
    const node = this.nodes.get(blockId);
    if (!node?.parentId) return;

    const siblings = this.getChildren(node.parentId);
    const myIndex = siblings.findIndex(s => s.blockId === blockId);
    if (myIndex <= 0) return; // Can't indent first child

    // New parent is the previous sibling
    const newParentId = siblings[myIndex - 1].blockId;
    const newParentChildren = this.getChildren(newParentId);

    const oldParentId = node.parentId;
    node.parentId = newParentId;
    node.orderIndex = newParentChildren.length;
    node.updatedAt = new Date().toISOString();

    this.rebuildChildrenIndex();
    this.scheduleEmit(blockId, oldParentId);
    this.scheduleEmit(blockId, newParentId);
  }

  private execOutdent(blockId: string): void {
    const node = this.nodes.get(blockId);
    if (!node?.parentId) return;

    const parent = this.nodes.get(node.parentId);
    if (!parent?.parentId) return; // Can't outdent from root level

    const oldParentId = node.parentId;
    const grandparentId = parent.parentId;

    // Position after current parent in grandparent's children
    const grandparentChildren = this.getChildren(grandparentId);
    const parentIndex = grandparentChildren.findIndex(s => s.blockId === oldParentId);

    node.parentId = grandparentId;
    node.orderIndex = parentIndex + 1;
    node.updatedAt = new Date().toISOString();

    // Move subsequent siblings of the indented node to become its children
    const formerSiblings = this.getChildren(oldParentId);
    const myOldIndex = formerSiblings.findIndex(s => s.blockId === blockId);
    const subsequentSiblings = formerSiblings.filter((_, i) => i > myOldIndex);
    for (let i = 0; i < subsequentSiblings.length; i++) {
      subsequentSiblings[i].parentId = blockId;
      subsequentSiblings[i].orderIndex = i;
    }

    this.rebuildChildrenIndex();
    this.scheduleEmit(blockId, oldParentId);
    this.scheduleEmit(blockId, grandparentId);
  }

  private execToggleCollapsed(blockId: string): void {
    const node = this.nodes.get(blockId);
    if (!node) return;
    node.collapsed = !node.collapsed;
    this.scheduleEmit(blockId, null);
  }

  private execSetCollapsed(blockId: string, collapsed: boolean): void {
    const node = this.nodes.get(blockId);
    if (!node) return;
    node.collapsed = collapsed;
    this.scheduleEmit(blockId, null);
  }

  private execReorder(parentId: string, orderedBlockIds: string[]): void {
    for (let i = 0; i < orderedBlockIds.length; i++) {
      const node = this.nodes.get(orderedBlockIds[i]);
      if (node) {
        node.orderIndex = i;
      }
    }
    this.rebuildChildrenIndex();
    this.scheduleEmit(null, parentId);
  }

  private execSetNodeType(blockId: string, nodeType: GraphNodeType): void {
    const node = this.nodes.get(blockId);
    if (!node) return;
    node.nodeType = nodeType;
    node.updatedAt = new Date().toISOString();
    this.scheduleEmit(blockId, null);
  }

  // ─── Undo / Redo ──────────────────────────────────────────────

  undo(): UndoEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.executeIntent(entry.reverse);
    this.redoStack.push(entry);
    this.emit({ type: 'undo', entry });
    return entry;
  }

  redo(): UndoEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.executeIntent(entry.forward);
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

  // ─── Projection ───────────────────────────────────────────────

  /**
   * Generate a flat projected node list from a query.
   * This is the primary interface for Lexical editors.
   */
  project(query: ProjectionQuery): ProjectedNode[] {
    const result: ProjectedNode[] = [];
    const rootNode = this.nodes.get(query.rootBlockId);
    if (!rootNode) return result;

    if (query.includeRoot) {
      result.push(this.toProjectedNode(rootNode, 0));
    }

    this.projectChildren(query.rootBlockId, query.includeRoot ? 1 : 0, query.maxDepth, result, query);
    return result;
  }

  private projectChildren(
    parentId: string,
    depth: number,
    maxDepth: number,
    result: ProjectedNode[],
    query: ProjectionQuery,
  ): void {
    if (maxDepth >= 0 && depth > maxDepth) return;

    const children = this.getChildren(parentId);
    const parentNode = this.nodes.get(parentId);
    const isCollapsed = parentNode?.collapsed ?? false;

    for (const child of children) {
      if (child.isDeleted) continue;
      if (query.nodeTypeFilter && !query.nodeTypeFilter.includes(child.nodeType)) continue;

      const projected = this.toProjectedNode(child, depth);
      projected.visible = !isCollapsed;
      result.push(projected);

      // Recurse if not collapsed
      if (!isCollapsed) {
        this.projectChildren(child.blockId, depth + 1, maxDepth, result, query);
      }
    }
  }

  private toProjectedNode(node: GraphNode, depth: number): ProjectedNode {
    const children = this.childrenIndex.get(node.blockId);
    return {
      blockId: node.blockId,
      depth,
      collapsed: node.collapsed,
      visible: true,
      nodeType: node.nodeType,
      contentAST: node.contentAST,
      isPage: node.isPage,
      name: node.name,
      icon: node.icon,
      color: node.color,
      hasChildren: (children?.length ?? 0) > 0,
      serverId: node.serverId,
      classIds: node.classIds,
    };
  }

  // ─── Event system ─────────────────────────────────────────────

  subscribe(handler: RuntimeEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('[NodeGraphRuntime] Event handler error:', e);
      }
    }
  }

  private scheduleEmit(blockId: string | null, parentId: string | null): void {
    if (blockId) this.pendingChangedBlockIds.add(blockId);
    if (parentId) this.pendingStructureParentIds.add(parentId);

    if (this.pendingFlush === null) {
      this.pendingFlush = requestAnimationFrame(() => {
        this.pendingFlush = null;
        if (this.pendingChangedBlockIds.size > 0) {
          this.emit({ type: 'nodes_changed', blockIds: [...this.pendingChangedBlockIds] });
          this.pendingChangedBlockIds.clear();
        }
        if (this.pendingStructureParentIds.size > 0) {
          this.emit({ type: 'structure_changed', parentIds: [...this.pendingStructureParentIds] });
          this.pendingStructureParentIds.clear();
        }
      });
    }
  }

  /** Flush any pending events immediately (for testing or synchronous needs) */
  flushEvents(): void {
    if (this.pendingFlush !== null) {
      cancelAnimationFrame(this.pendingFlush);
      this.pendingFlush = null;
    }
    if (this.pendingChangedBlockIds.size > 0) {
      this.emit({ type: 'nodes_changed', blockIds: [...this.pendingChangedBlockIds] });
      this.pendingChangedBlockIds.clear();
    }
    if (this.pendingStructureParentIds.size > 0) {
      this.emit({ type: 'structure_changed', parentIds: [...this.pendingStructureParentIds] });
      this.pendingStructureParentIds.clear();
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private rebuildChildrenIndex(): void {
    this.childrenIndex.clear();
    for (const node of this.nodes.values()) {
      if (node.parentId) {
        let children = this.childrenIndex.get(node.parentId);
        if (!children) {
          children = [];
          this.childrenIndex.set(node.parentId, children);
        }
        children.push(node.blockId);
      }
    }

    // Sort each children list by orderIndex
    for (const [, children] of this.childrenIndex) {
      children.sort((a, b) => {
        const nodeA = this.nodes.get(a);
        const nodeB = this.nodes.get(b);
        return (nodeA?.orderIndex ?? 0) - (nodeB?.orderIndex ?? 0);
      });
    }
  }

  private computeReverse(intent: MutationIntent): MutationIntent | null {
    switch (intent.type) {
      case 'update_content': {
        const node = this.nodes.get(intent.blockId);
        if (!node) return null;
        return { type: 'update_content', blockId: intent.blockId, contentAST: [...node.contentAST] };
      }
      case 'create_block':
        return { type: 'delete_block', blockId: intent.blockId };
      case 'delete_block': {
        const node = this.nodes.get(intent.blockId);
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
        const node = this.nodes.get(intent.blockId);
        if (!node) return null;
        const siblings = node.parentId ? this.getChildren(node.parentId) : [];
        const myIndex = siblings.findIndex(s => s.blockId === intent.blockId);
        const afterId = myIndex > 0 ? siblings[myIndex - 1].blockId : null;
        return { type: 'move_block', blockId: intent.blockId, newParentId: node.parentId || '', afterBlockId: afterId };
      }
      case 'indent_block':
        return { type: 'outdent_block', blockId: intent.blockId };
      case 'outdent_block':
        return { type: 'indent_block', blockId: intent.blockId };
      case 'toggle_collapsed':
        return { type: 'toggle_collapsed', blockId: intent.blockId };
      case 'set_collapsed': {
        const node = this.nodes.get(intent.blockId);
        if (!node) return null;
        return { type: 'set_collapsed', blockId: intent.blockId, collapsed: node.collapsed };
      }
      case 'batch': {
        const reverses: MutationIntent[] = [];
        for (const sub of intent.intents) {
          const rev = this.computeReverse(sub);
          if (rev) reverses.unshift(rev); // Reverse order for undo
        }
        return { type: 'batch', intents: reverses };
      }
      default:
        return null;
    }
  }
}

// ─── Content AST helpers ──────────────────────────────────────────

function splitContentASTAtOffset(
  content: ContentAST,
  offset: number,
): { before: ContentAST; after: ContentAST } {
  if (content.length === 0) {
    return {
      before: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
      after: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    };
  }

  // Flatten to count characters
  let charCount = 0;
  let splitParaIndex = 0;
  let splitCharOffset = 0;

  for (let i = 0; i < content.length; i++) {
    const para = content[i];
    for (const child of para.children) {
      const len = getInlineLength(child);
      if (charCount + len >= offset) {
        splitParaIndex = i;
        splitCharOffset = offset - charCount;
        break;
      }
      charCount += len;
    }
    if (charCount >= offset) break;
    charCount++; // paragraph break
  }

  const before = content.slice(0, splitParaIndex);
  const after = content.slice(splitParaIndex + 1);

  const splitPara = content[splitParaIndex];
  if (splitPara) {
    const { beforeInlines, afterInlines } = splitInlinesAtOffset(splitPara.children, splitCharOffset);
    before.push({ type: 'paragraph', children: beforeInlines });
    after.unshift({ type: 'paragraph', children: afterInlines });
  }

  return { before, after };
}

function mergeContentASTs(a: ContentAST, b: ContentAST): ContentAST {
  if (a.length === 0) return b;
  if (b.length === 0) return a;

  const result = [...a];
  const lastPara = result[result.length - 1];
  const firstB = b[0];

  // Merge last paragraph of a with first paragraph of b
  result[result.length - 1] = {
    type: 'paragraph',
    children: [...lastPara.children, ...firstB.children],
  };

  // Add remaining paragraphs from b
  for (let i = 1; i < b.length; i++) {
    result.push(b[i]);
  }

  return result;
}

import type { ASTInlineNode } from '@/types/ast';

function getInlineLength(node: ASTInlineNode): number {
  switch (node.type) {
    case 'text':
      return node.text.length;
    case 'hard_break':
      return 1;
    case 'node_link':
      return 1; // Pills count as 1 character
    case 'code':
      return node.text.length;
    case 'strong':
    case 'em':
    case 'strikethrough':
    case 'underline':
    case 'highlight':
      return node.children.reduce((sum: number, c: ASTInlineNode) => sum + getInlineLength(c), 0);
    case 'external_link':
      return node.children.reduce((sum: number, c: ASTInlineNode) => sum + getInlineLength(c), 0);
    default:
      return 0;
  }
}

function splitInlinesAtOffset(
  inlines: ASTInlineNode[],
  offset: number,
): { beforeInlines: ASTInlineNode[]; afterInlines: ASTInlineNode[] } {
  const before: ASTInlineNode[] = [];
  const after: ASTInlineNode[] = [];
  let remaining = offset;

  for (let i = 0; i < inlines.length; i++) {
    const node = inlines[i];
    const len = getInlineLength(node);

    if (remaining <= 0) {
      after.push(node);
    } else if (remaining >= len) {
      before.push(node);
      remaining -= len;
    } else {
      // Split this node
      if (node.type === 'text') {
        before.push({ type: 'text', text: node.text.slice(0, remaining) });
        after.push({ type: 'text', text: node.text.slice(remaining) });
      } else {
        before.push(node);
      }
      remaining = 0;
    }
  }

  // Ensure non-empty
  if (before.length === 0) before.push({ type: 'text', text: '' });
  if (after.length === 0) after.push({ type: 'text', text: '' });

  return { beforeInlines: before, afterInlines: after };
}

// ─── Singleton ────────────────────────────────────────────────────

let runtimeInstance: NodeGraphRuntime | null = null;

export function getNodeGraphRuntime(): NodeGraphRuntime {
  if (!runtimeInstance) {
    runtimeInstance = new NodeGraphRuntime();
  }
  return runtimeInstance;
}

export function resetNodeGraphRuntime(): void {
  runtimeInstance = new NodeGraphRuntime();
}
