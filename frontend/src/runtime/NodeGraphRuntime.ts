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
  SliceProjectionQuery,
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
  private pendingSource?: 'intent' | 'sync' | 'undo' | 'redo';
  private pendingSourceEditorId?: string;

  /** Block ID and optional offset to focus after next sync (used by editors) */
  private pendingFocus: { blockId: string; offset?: number } | null = null;

  /** Pending block ID remaps (old → new) from remapBlockId calls.
   *  Consumed by editors during sync to update existing Lexical nodes
   *  in-place instead of removing + recreating them. */
  private pendingRemaps = new Map<string, string>();

  /**
   * Parent serverId mapping for nodes that aren't full GraphNodes.
   * Used when the parent (e.g. a page) isn't loaded into the runtime
   * but its serverId is needed for persisting child blocks.
   */
  private parentServerIds = new Map<string, number>();

  /**
   * Table blocks currently in outline mode.
   * When in outline mode, table children are projected normally as blocks
   * instead of being hidden and rendered by TableBlockPlugin.
   */
  private tableOutlineBlockIds = new Set<string>();

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
    this.emit({ type: 'structure_changed', parentIds: ['__root__'], source: 'sync' });
  }

  /**
   * Incrementally update/add nodes from the backend.
   * Only emits events when data actually changes to prevent infinite loops.
   *
   * @param options.preserveCollapsed  When true (default), keeps the runtime's
   *   collapsed state for existing nodes — protecting client-side
   *   collapse/expand from being overwritten by API syncs (e.g. after a
   *   color change).  Pass false on initial view load so the DB collapsed
   *   value is used instead of a stale runtime value from a previous view.
   */
  upsertNodes(nodes: GraphNode[], options?: { preserveCollapsed?: boolean }): void {
    const preserveCollapsed = options?.preserveCollapsed ?? true;
    const changedParents = new Set<string>();
    const changedBlockIds: string[] = [];

    for (const node of nodes) {
      const existing = this.nodes.get(node.blockId);
      if (!existing) {
        // New node — mark parent as structurally changed
        if (node.parentId) changedParents.add(node.parentId);
        changedBlockIds.push(node.blockId);
        this.nodes.set(node.blockId, node);
      } else {
        // Existing node — update metadata fields but PRESERVE:
        //
        // parentId / orderIndex: the runtime is the source of truth
        // for structure during editing.  Indent, outdent, drag and
        // reorder update these fields optimistically; a concurrent
        // refetch may return pre-change values that would revert the
        // user's action until the next server round-trip.
        //
        // collapsed: managed client-side via applyIntent.  During
        // in-view API syncs (e.g. after a color change) we preserve
        // it, but on initial view load we use the API value so a
        // previous view's state doesn't leak.
        //
        // contentAST: the runtime is the source of truth during active
        // editing.  However, when the server has a newer write_date
        // (e.g. after a bulk fix like fix-raw-uuid-links), we accept
        // the server's content so the UI reflects the update without
        // requiring a page reload.
        const serverTime = new Date(node.updatedAt).getTime();
        const localTime = new Date(existing.updatedAt).getTime();
        const serverIsNewer = serverTime > localTime;

        const merged: GraphNode = {
          ...node,
          contentAST: serverIsNewer ? node.contentAST : existing.contentAST,
          parentId: existing.parentId,
          orderIndex: existing.orderIndex,
          collapsed: preserveCollapsed ? existing.collapsed : node.collapsed,
        };

        // Detect metadata-only changes (parentId / orderIndex are
        // preserved so they never trigger structure_changed here).
        if (
          existing.name !== merged.name ||
          existing.icon !== merged.icon ||
          existing.color !== merged.color ||
          existing.isDeleted !== merged.isDeleted ||
          existing.classIds.join(',') !== merged.classIds.join(',') ||
          serverIsNewer
        ) {
          changedBlockIds.push(node.blockId);
        }
        this.nodes.set(node.blockId, merged);
      }
    }

    // Only rebuild index and emit events if something actually changed
    if (changedParents.size > 0 || changedBlockIds.length > 0) {
      this.rebuildChildrenIndex();
    }

    if (changedParents.size > 0) {
      this.emit({ type: 'structure_changed', parentIds: [...changedParents], source: 'sync' });
    }
    if (changedBlockIds.length > 0) {
      this.emit({ type: 'nodes_changed', blockIds: changedBlockIds, source: 'sync' });
    }
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
      this.emit({ type: 'structure_changed', parentIds: [...parentIds], source: 'sync' });
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

  /**
   * Assign a server-side numeric ID to a runtime node.
   * Called after the API creates the node and returns its ID.
   */
  setServerId(blockId: string, serverId: number): void {
    const node = this.nodes.get(blockId);
    if (!node) return;
    node.serverId = serverId;
  }

  /**
   * Remap a runtime block from an old blockId to a new blockId.
   * Used when an optimistic block (e.g. "optimistic-123") is confirmed
   * by the server with a real UUID. Updates the node map, children index,
   * and pending focus in-place, then emits a structure_changed event so
   * Lexical editors sync their BlockNode blockIds with the new value.
   */
  remapBlockId(oldBlockId: string, newBlockId: string): void {
    const node = this.nodes.get(oldBlockId);
    if (!node) return;
    if (oldBlockId === newBlockId) return;

    const parentId = node.parentId;

    // Move in node map
    this.nodes.delete(oldBlockId);
    node.blockId = newBlockId;
    this.nodes.set(newBlockId, node);

    // Update children whose parentId pointed to old ID
    for (const child of this.nodes.values()) {
      if (child.parentId === oldBlockId) {
        child.parentId = newBlockId;
      }
    }

    // Rebuild children index since parentIds changed
    this.rebuildChildrenIndex();

    // Update pendingFocus if it targeted the old blockId
    if (this.pendingFocus?.blockId === oldBlockId) {
      this.pendingFocus.blockId = newBlockId;
    }

    // Track the remap so editors can update in-place instead of remove+create
    this.pendingRemaps.set(oldBlockId, newBlockId);

    // Emit structure_changed so Lexical editors replace the old
    // optimistic BlockNode with one carrying the real blockId.
    if (parentId) {
      this.emit({ type: 'structure_changed', parentIds: [parentId], source: 'sync' });
    }
  }

  /**
   * Get a node by its server ID (numeric ID from API).
   * Returns null if not found.
   */
  getNodeByServerId(serverId: number): GraphNode | null {
    for (const node of this.nodes.values()) {
      if (node.serverId === serverId) return node;
    }
    return null;
  }

  /**
   * Request that the next projected block (matching blockId) be focused.
   * Used by editors to focus newly created blocks.
   * @param blockId - Block to focus
   * @param offset - Optional character offset to position cursor (default: 0 = start)
   */
  requestFocus(blockId: string, offset?: number): void {
    this.pendingFocus = { blockId, offset };
  }

  /**
   * Get the pending focus request (does not clear it).
   * Editors call this during sync to check if a block should be focused.
   */
  getPendingFocus(): { blockId: string; offset?: number } | null {
    return this.pendingFocus;
  }

  /**
   * Clear the pending focus request. Called after block has been focused.
   */
  clearPendingFocus(): void {
    this.pendingFocus = null;
  }

  /**
   * Get and clear all pending block ID remaps.
   * Used by editors to update existing nodes in-place during sync.
   */
  consumePendingRemaps(): Map<string, string> {
    if (this.pendingRemaps.size === 0) return this.pendingRemaps;
    const remaps = this.pendingRemaps;
    this.pendingRemaps = new Map();
    return remaps;
  }

  /**
   * Register a parent's serverId without creating a full GraphNode.
   * Used when the parent (e.g. a page) provides context for persistence
   * but doesn't need to be in the node graph itself.
   */
  registerParentServerId(parentBlockId: string, serverId: number): void {
    this.parentServerIds.set(parentBlockId, serverId);
  }

  /**
   * Resolve a parent's serverId - checks both full GraphNodes and
   * the lightweight parent mapping.
   */
  resolveParentServerId(parentBlockId: string): number | null {
    const node = this.nodes.get(parentBlockId);
    if (node?.serverId != null) return node.serverId;
    return this.parentServerIds.get(parentBlockId) ?? null;
  }

  /**
   * Get all nodes that have no serverId (i.e. not yet persisted).
   * Excludes virtual root nodes (blockIds starting with '__').
   */
  getUnpersistedNodes(): GraphNode[] {
    const result: GraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.serverId == null && !node.blockId.startsWith('__')) {
        result.push(node);
      }
    }
    return result;
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
        this.execUpdateContent(intent.blockId, intent.contentAST, intent.sourceEditorId);
        break;
      case 'split_block':
        this.execSplitBlock(intent.blockId, intent.atOffset, intent.newBlockId, intent.forceSibling);
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
      case 'move_up':
        this.execMoveUp(intent.blockId);
        break;
      case 'move_down':
        this.execMoveDown(intent.blockId);
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

  private execUpdateContent(blockId: string, contentAST: ContentAST, sourceEditorId?: string): void {
    const node = this.nodes.get(blockId);
    if (!node) return;
    node.contentAST = contentAST;
    node.updatedAt = new Date().toISOString();
    this.scheduleEmit(blockId, null, 'intent', sourceEditorId);
  }

  private execSplitBlock(blockId: string, atOffset: number, newBlockId: string, forceSibling?: boolean): void {
    const node = this.nodes.get(blockId);
    if (!node) return;

    // Split contentAST at offset
    const { before, after } = splitContentASTAtOffset(node.contentAST, atOffset);

    // Update existing node with content before split
    node.contentAST = before;
    node.updatedAt = new Date().toISOString();

    // Check if block has children
    const children = this.getChildren(blockId);
    const hasChildren = children.length > 0;

    // Determine where to create the new block
    let newParentId: string | null;
    let orderIndex: number;

    if (hasChildren && !forceSibling) {
      // Block has children: create new block as FIRST CHILD
      newParentId = blockId;
      orderIndex = 0;

      // Shift all existing children down
      for (const child of children) {
        child.orderIndex += 1;
      }
    } else {
      // Block has no children (or forceSibling): create new block as SIBLING
      newParentId = node.parentId;
      const siblings = newParentId ? (this.childrenIndex.get(newParentId) || []) : [];
      const myIndex = siblings.indexOf(blockId);
      orderIndex = myIndex >= 0 ? myIndex + 1 : siblings.length;

      // Shift subsequent siblings
      for (let i = orderIndex; i < siblings.length; i++) {
        const sib = this.nodes.get(siblings[i]);
        if (sib) sib.orderIndex = i + 1;
      }
    }

    const newNode: GraphNode = {
      blockId: newBlockId,
      parentId: newParentId,
      orderIndex,
      nodeType: 'block',
      contentAST: after,
      collapsed: false,
      isDeleted: false,
      isPage: false,
      name: '',
      classIds: [],
      tagIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    this.nodes.set(newBlockId, newNode);
    this.rebuildChildrenIndex();
    this.scheduleEmit(blockId, newParentId);
    this.scheduleEmit(newBlockId, null);
  }

  private execMergeBlocks(sourceBlockId: string, targetBlockId: string): void {
    const source = this.nodes.get(sourceBlockId);
    const target = this.nodes.get(targetBlockId);
    if (!source || !target) return;

    // Capture serverId before removing the node
    const sourceServerId = source.serverId;

    // Calculate merge point offset (end of target's original content)
    const mergeOffset = getContentASTLength(target.contentAST);

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
    this.emit({ type: 'block_deleted', blockId: sourceBlockId, serverId: sourceServerId });
    this.scheduleEmit(targetBlockId, parentId);

    // Request focus at the merge point (end of original target content)
    this.requestFocus(targetBlockId, mergeOffset);
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
      name: '',
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

    // Capture serverId before removing the node
    const serverId = node.serverId;

    // Recursively delete descendants — emit delete events for each
    const descendants = this.getDescendants(blockId);
    for (const desc of descendants) {
      if (desc.serverId != null) {
        this.emit({ type: 'block_deleted', blockId: desc.blockId, serverId: desc.serverId });
      }
      this.nodes.delete(desc.blockId);
    }

    const parentId = node.parentId;
    this.nodes.delete(blockId);
    this.rebuildChildrenIndex();
    this.emit({ type: 'block_deleted', blockId, serverId });
    this.scheduleEmit(blockId, parentId);
  }

  private execMoveBlock(blockId: string, newParentId: string, afterBlockId: string | null): void {
    const node = this.nodes.get(blockId);
    if (!node) return;

    const oldParentId = node.parentId;

    // Remove from old parent's children index before reading new siblings
    const oldChildren = this.childrenIndex.get(oldParentId || '') || [];
    const oldIdx = oldChildren.indexOf(blockId);
    if (oldIdx >= 0) oldChildren.splice(oldIdx, 1);

    // Read new siblings (now excludes the moved block)
    const newSiblings = (newParentId === oldParentId)
      ? oldChildren
      : (this.childrenIndex.get(newParentId) || []);

    // Determine insertion index
    let insertIdx: number;
    if (afterBlockId) {
      const afterIdx = newSiblings.indexOf(afterBlockId);
      insertIdx = afterIdx >= 0 ? afterIdx + 1 : newSiblings.length;
    } else {
      insertIdx = 0;
    }

    // Update parent
    node.parentId = newParentId;

    // Reindex all siblings at the target parent for clean ordering
    // Insert moved block at the right position
    newSiblings.splice(insertIdx, 0, blockId);
    for (let i = 0; i < newSiblings.length; i++) {
      const sibling = this.nodes.get(newSiblings[i]);
      if (sibling) sibling.orderIndex = i;
    }

    // Also reindex old parent's children if different
    if (newParentId !== oldParentId) {
      for (let i = 0; i < oldChildren.length; i++) {
        const sibling = this.nodes.get(oldChildren[i]);
        if (sibling) sibling.orderIndex = i;
      }
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
    
    // Get existing children to append subsequent siblings after them
    const existingChildren = this.getChildren(blockId);
    const startIndex = existingChildren.length;
    
    for (let i = 0; i < subsequentSiblings.length; i++) {
      subsequentSiblings[i].parentId = blockId;
      subsequentSiblings[i].orderIndex = startIndex + i;
    }

    this.rebuildChildrenIndex();
    this.scheduleEmit(blockId, oldParentId);
    this.scheduleEmit(blockId, grandparentId);
    
    // Emit structure change for the outdented block if its children changed
    if (subsequentSiblings.length > 0 || existingChildren.length > 0) {
      this.scheduleEmit(null, blockId);
    }
  }

  /**
   * Move block up among siblings, or to previous parent's last position if first sibling.
   * Maintains hierarchy level - only moves to parents at the same depth.
   */
  private execMoveUp(blockId: string): void {
    const node = this.nodes.get(blockId);
    if (!node?.parentId) return;

    const parent = this.nodes.get(node.parentId);
    if (!parent) return;

    const siblings = this.getChildren(node.parentId);
    const myIndex = siblings.findIndex(s => s.blockId === blockId);
    
    if (myIndex > 0) {
      // Not first sibling - swap with previous sibling
      const prevSibling = siblings[myIndex - 1];
      node.orderIndex = myIndex - 1;
      prevSibling.orderIndex = myIndex;
      node.updatedAt = new Date().toISOString();
      prevSibling.updatedAt = new Date().toISOString();
      
      this.rebuildChildrenIndex();
      this.scheduleEmit(blockId, node.parentId);
    } else if (myIndex === 0 && parent.parentId) {
      // First sibling - try to move to previous parent at same level
      const grandparent = this.nodes.get(parent.parentId);
      if (!grandparent) return;
      
      const parentSiblings = this.getChildren(parent.parentId);
      const parentIndex = parentSiblings.findIndex(s => s.blockId === node.parentId);
      
      if (parentIndex > 0) {
        // There's a previous parent sibling - move to it as last child
        const prevParentId = parentSiblings[parentIndex - 1].blockId;
        const prevParentChildren = this.getChildren(prevParentId);
        
        const oldParentId = node.parentId;
        node.parentId = prevParentId;
        node.orderIndex = prevParentChildren.length;
        node.updatedAt = new Date().toISOString();
        
        this.rebuildChildrenIndex();
        this.scheduleEmit(blockId, oldParentId);
        this.scheduleEmit(blockId, prevParentId);
      }
    }
  }

  /**
   * Move block down among siblings, or to next parent's first position if last sibling.
   * Maintains hierarchy level - only moves to parents at the same depth.
   */
  private execMoveDown(blockId: string): void {
    const node = this.nodes.get(blockId);
    if (!node?.parentId) return;

    const parent = this.nodes.get(node.parentId);
    if (!parent) return;

    const siblings = this.getChildren(node.parentId);
    const myIndex = siblings.findIndex(s => s.blockId === blockId);
    
    if (myIndex < siblings.length - 1) {
      // Not last sibling - swap with next sibling
      const nextSibling = siblings[myIndex + 1];
      node.orderIndex = myIndex + 1;
      nextSibling.orderIndex = myIndex;
      node.updatedAt = new Date().toISOString();
      nextSibling.updatedAt = new Date().toISOString();
      
      this.rebuildChildrenIndex();
      this.scheduleEmit(blockId, node.parentId);
    } else if (myIndex === siblings.length - 1 && parent.parentId) {
      // Last sibling - try to move to next parent at same level
      const grandparent = this.nodes.get(parent.parentId);
      if (!grandparent) return;
      
      const parentSiblings = this.getChildren(parent.parentId);
      const parentIndex = parentSiblings.findIndex(s => s.blockId === node.parentId);
      
      if (parentIndex < parentSiblings.length - 1) {
        // There's a next parent sibling - move to it as first child
        const nextParentId = parentSiblings[parentIndex + 1].blockId;
        
        const oldParentId = node.parentId;
        node.parentId = nextParentId;
        node.orderIndex = 0;
        node.updatedAt = new Date().toISOString();
        
        // Shift existing children of next parent down
        const nextParentChildren = this.getChildren(nextParentId);
        for (const child of nextParentChildren) {
          child.orderIndex += 1;
        }
        
        this.rebuildChildrenIndex();
        this.scheduleEmit(blockId, oldParentId);
        this.scheduleEmit(blockId, nextParentId);
      }
    }
  }

  private execToggleCollapsed(blockId: string): void {
    const node = this.nodes.get(blockId);
    if (!node) return;
    node.collapsed = !node.collapsed;
    this.scheduleEmit(blockId, null);
    this.emit({ type: 'collapse_changed', blockId, serverId: node.serverId, collapsed: node.collapsed });
    // If expanding and children haven't been loaded yet, request them
    if (!node.collapsed && node.hasServerChildren && this.getChildren(blockId).length === 0) {
      this.emit({ type: 'expand_children_needed', blockId, serverId: node.serverId });
    }
  }

  private execSetCollapsed(blockId: string, collapsed: boolean): void {
    const node = this.nodes.get(blockId);
    if (!node) return;
    node.collapsed = collapsed;
    this.scheduleEmit(blockId, null);
    this.emit({ type: 'collapse_changed', blockId, serverId: node.serverId, collapsed });
    // If expanding and children haven't been loaded yet, request them
    if (!collapsed && node.hasServerChildren && this.getChildren(blockId).length === 0) {
      this.emit({ type: 'expand_children_needed', blockId, serverId: node.serverId });
    }
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

    if (query.includeRoot && rootNode) {
      result.push(this.toProjectedNode(rootNode, 0));
    }

    // Project children even if rootBlockId is not a full GraphNode.
    // The childrenIndex is built from children's parentId, so it works
    // as long as children reference this ID as their parent.
    const startDepth = (query.includeRoot && rootNode) ? 1 : 0;
    this.projectChildren(query.rootBlockId, startDepth, query.maxDepth, result, query);
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
      if (query.skipPages !== false && child.isPage) continue;
      if (query.nodeTypeFilter && !query.nodeTypeFilter.includes(child.nodeType)) continue;

      const projected = this.toProjectedNode(child, depth);
      projected.visible = !isCollapsed;
      result.push(projected);

      // Recurse if not collapsed
      // Skip children of table blocks unless they are in outline mode
      const isTableHidden = child.nodeType === 'table' && !this.tableOutlineBlockIds.has(child.blockId);
      if (!isCollapsed && !isTableHidden) {
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
      hasChildren: (children?.length ?? 0) > 0 || (node.hasServerChildren ?? false),
      serverId: node.serverId,
      classIds: node.classIds,
      taskStatus: node.taskStatus ?? null,
      isProjectionRoot: false,
    };
  }

  // ─── Slice Projection ──────────────────────────────────────────

  /**
   * Generate a flat projected node list from an arbitrary slice of nodes.
   *
   * When showParent is true, nodes are grouped by parentId and each parent
   * is rendered as a locked projection root above its children.
   * When showParent is false, nodes are rendered in the order provided,
   * preserving the caller's sort/filter intent.
   *
   * Children are recursively expanded according to recursiveLevel.
   */
  projectSlice(query: SliceProjectionQuery): ProjectedNode[] {
    const result: ProjectedNode[] = [];
    const projected = new Set<string>();

    if (query.showParent) {
      // ── Grouped mode: group slice nodes by parentId ──────────
      // Preserves input order within each group (caller controls sort).
      const groups = new Map<string, string[]>();
      for (const blockId of query.nodeBlockIds) {
        const node = this.nodes.get(blockId);
        if (!node || node.isDeleted) continue;
        const parentId = node.parentId || '__orphan__';
        if (!groups.has(parentId)) groups.set(parentId, []);
        groups.get(parentId)!.push(blockId);
      }

      for (const [parentId, blockIds] of groups) {
        let baseDepth = 0;

        // Show parent as a locked projection root
        if (parentId !== '__orphan__') {
          const parent = this.nodes.get(parentId);
          if (parent && !projected.has(parentId)) {
            const pn = this.toProjectedNode(parent, 0);
            pn.isProjectionRoot = true;
            result.push(pn);
            projected.add(parentId);
            baseDepth = 1;
          }
        }

        for (const blockId of blockIds) {
          this.projectSliceNode(blockId, baseDepth, query.recursiveLevel, result, projected);
        }
      }
    } else {
      // ── Ordered mode: render nodes in the order provided ─────
      for (const blockId of query.nodeBlockIds) {
        this.projectSliceNode(blockId, 0, query.recursiveLevel, result, projected);
      }
    }

    return result;
  }

  /**
   * Project a single slice node and optionally its descendants.
   */
  private projectSliceNode(
    blockId: string,
    depth: number,
    recursiveLevel: number,
    result: ProjectedNode[],
    projected: Set<string>,
  ): void {
    if (projected.has(blockId)) return;
    const node = this.nodes.get(blockId);
    if (!node || node.isDeleted) return;

    result.push(this.toProjectedNode(node, depth));
    projected.add(blockId);

    // Recursive expansion of children
    if (recursiveLevel !== 0) {
      const maxDepth = recursiveLevel === -1
        ? -1
        : depth + recursiveLevel;
      this.projectSliceDescendants(
        blockId, depth + 1, maxDepth, result, projected,
      );
    }
  }

  /**
   * Recursively project descendants for a slice node.
   * Respects collapsed state and deduplicates with the `projected` set.
   */
  private projectSliceDescendants(
    parentId: string,
    depth: number,
    maxDepth: number,
    result: ProjectedNode[],
    projected: Set<string>,
  ): void {
    if (maxDepth >= 0 && depth > maxDepth) return;

    const children = this.getChildren(parentId);
    const parentNode = this.nodes.get(parentId);
    const isCollapsed = parentNode?.collapsed ?? false;

    for (const child of children) {
      if (child.isDeleted) continue;
      if (projected.has(child.blockId)) continue;

      const pn = this.toProjectedNode(child, depth);
      pn.visible = !isCollapsed;
      result.push(pn);
      projected.add(child.blockId);

      if (!isCollapsed) {
        this.projectSliceDescendants(
          child.blockId, depth + 1, maxDepth, result, projected,
        );
      }
    }
  }

  // ─── Event system ─────────────────────────────────────────────

  subscribe(handler: RuntimeEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /**
   * Subscribe to events that affect a specific block.
   * The handler is only called for 'nodes_changed' events that include
   * the given blockId, or 'structure_changed' / 'block_deleted' events
   * that may affect its parent hierarchy.
   */
  subscribeToBlock(
    blockId: string,
    handler: RuntimeEventHandler,
  ): () => void {
    const wrapped: RuntimeEventHandler = (event) => {
      let relevant = false;
      if (event.type === 'nodes_changed') {
        relevant = event.blockIds.includes(blockId);
      } else if (event.type === 'structure_changed') {
        const node = this.nodes.get(blockId);
        relevant = node ? event.parentIds.includes(node.parentId ?? '') : false;
      } else if (event.type === 'block_deleted') {
        relevant = event.blockId === blockId;
      } else if (event.type === 'collapse_changed') {
        relevant = event.blockId === blockId;
      }
      if (relevant) {
        handler(event);
      }
    };
    this.listeners.add(wrapped);
    return () => this.listeners.delete(wrapped);
  }

  /**
   * Toggle a table block between table view (children hidden) and outline
   * view (children projected as normal blocks).
   */
  setTableOutlineMode(blockId: string, isOutline: boolean): void {
    const changed = isOutline
      ? !this.tableOutlineBlockIds.has(blockId) && (this.tableOutlineBlockIds.add(blockId), true)
      : this.tableOutlineBlockIds.delete(blockId);
    if (changed) {
      // Emit structure change to trigger re-projection
      this.emit({ type: 'structure_changed', parentIds: [blockId], source: 'intent' });
    }
  }

  /** Check if a table block is in outline mode. */
  isTableOutlineMode(blockId: string): boolean {
    return this.tableOutlineBlockIds.has(blockId);
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

  private scheduleEmit(
    blockId: string | null,
    parentId: string | null,
    source?: 'intent' | 'sync' | 'undo' | 'redo',
    sourceEditorId?: string,
  ): void {
    if (blockId) this.pendingChangedBlockIds.add(blockId);
    if (parentId) this.pendingStructureParentIds.add(parentId);
    if (source) this.pendingSource = source;
    if (sourceEditorId) this.pendingSourceEditorId = sourceEditorId;

    if (this.pendingFlush === null) {
      this.pendingFlush = requestAnimationFrame(() => {
        this.pendingFlush = null;
        const emitSource = this.pendingSource;
        const emitSourceEditorId = this.pendingSourceEditorId;
        this.pendingSource = undefined;
        this.pendingSourceEditorId = undefined;
        if (this.pendingChangedBlockIds.size > 0) {
          this.emit({ type: 'nodes_changed', blockIds: [...this.pendingChangedBlockIds], source: emitSource, sourceEditorId: emitSourceEditorId });
          this.pendingChangedBlockIds.clear();
        }
        if (this.pendingStructureParentIds.size > 0) {
          this.emit({ type: 'structure_changed', parentIds: [...this.pendingStructureParentIds], source: 'intent' });
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
    const emitSource = this.pendingSource;
    const emitSourceEditorId = this.pendingSourceEditorId;
    this.pendingSource = undefined;
    this.pendingSourceEditorId = undefined;
    if (this.pendingChangedBlockIds.size > 0) {
      this.emit({ type: 'nodes_changed', blockIds: [...this.pendingChangedBlockIds], source: emitSource, sourceEditorId: emitSourceEditorId });
      this.pendingChangedBlockIds.clear();
    }
    if (this.pendingStructureParentIds.size > 0) {
      this.emit({ type: 'structure_changed', parentIds: [...this.pendingStructureParentIds], source: 'intent' });
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
      case 'move_up':
        return { type: 'move_down', blockId: intent.blockId };
      case 'move_down':
        return { type: 'move_up', blockId: intent.blockId };
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
  let found = false;

  for (let i = 0; i < content.length; i++) {
    const para = content[i];
    if (!para.children) continue;
    const paraStart = charCount;
    for (const child of para.children) {
      const len = getInlineLength(child);
      if (charCount + len >= offset) {
        splitParaIndex = i;
        splitCharOffset = offset - paraStart;
        found = true;
        break;
      }
      charCount += len;
    }
    if (found) break;
    charCount++; // paragraph break
  }

  // Offset beyond content: split at end (everything stays in "before")
  if (!found) {
    return {
      before: content.map(p => ({ ...p, children: p.children ? [...p.children] : [] })),
      after: [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text: '' }] }],
    };
  }

  const before = content.slice(0, splitParaIndex);
  const after = content.slice(splitParaIndex + 1);

  const splitPara = content[splitParaIndex];
  if (splitPara && splitPara.children) {
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
  // Then normalize adjacent plain-text nodes so the runtime's AST
  // matches what Lexical produces after its own text-node merge pass.
  const merged = [...(lastPara.children || []), ...(firstB.children || [])];
  const normalized: ASTInlineNode[] = [];
  for (const node of merged) {
    const prev = normalized.length > 0 ? normalized[normalized.length - 1] : null;
    if (prev && prev.type === 'text' && node.type === 'text') {
      // Merge adjacent plain-text nodes
      normalized[normalized.length - 1] = { type: 'text', text: prev.text + node.text };
    } else {
      normalized.push(node);
    }
  }

  result[result.length - 1] = {
    type: 'paragraph',
    children: normalized,
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
    case 'broken_link':
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

/**
 * Calculate the total text length of a ContentAST (for cursor positioning).
 */
function getContentASTLength(content: ContentAST): number {
  if (content.length === 0) return 0;
  
  let totalLength = 0;
  for (let i = 0; i < content.length; i++) {
    const para = content[i];
    if (!para.children) continue;
    for (const child of para.children) {
      totalLength += getInlineLength(child);
    }
    // Add paragraph break (except after last paragraph)
    if (i < content.length - 1) {
      totalLength++;
    }
  }
  return totalLength;
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
      } else if ('children' in node && Array.isArray(node.children)) {
        // Recursively split wrapper nodes (strong, em, strikethrough, etc.)
        const { beforeInlines, afterInlines } = splitInlinesAtOffset(node.children, remaining);
        const hasBeforeContent = beforeInlines.length > 0 && !(beforeInlines.length === 1 && beforeInlines[0].type === 'text' && beforeInlines[0].text === '');
        const hasAfterContent = afterInlines.length > 0 && !(afterInlines.length === 1 && afterInlines[0].type === 'text' && afterInlines[0].text === '');
        if (hasBeforeContent) {
          before.push({ ...node, children: beforeInlines } as ASTInlineNode);
        }
        if (hasAfterContent) {
          after.push({ ...node, children: afterInlines } as ASTInlineNode);
        }
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
