/**
 * Core types for the NodeGraphRuntime architecture.
 *
 * Every entity in Notees is a "graph node" managed by the runtime.
 * Lexical editors are projections of subsets of this graph.
 */

import type { ASTDocument } from '@/types/ast';

// ─── Content AST ──────────────────────────────────────────────────

/**
 * ContentAST is the canonical ASTDocument from types/ast.ts.
 * No duplicate AST types — we use the single source of truth.
 */
export type ContentAST = ASTDocument;

// ─── Graph Nodes ──────────────────────────────────────────────────

/** The type of a graph node - determines rendering and behavior */
export type GraphNodeType =
  | 'page'
  | 'block'
  | 'card'
  | 'query'
  | 'table'
  | 'code'
  | 'asset'
  | 'day'
  | 'month'
  | 'year'
  | 'template'
  | 'comment';

/** A node in the graph - the fundamental unit of content */
export interface GraphNode {
  /** Unique block ID (UUID string) */
  blockId: string;
  /** Server-side numeric ID (for API compat) */
  serverId?: number;
  /** Parent block ID, null for root pages */
  parentId: string | null;
  /** Position within siblings */
  orderIndex: number;
  /** The semantic type of this node */
  nodeType: GraphNodeType;
  /** Inline content AST */
  contentAST: ContentAST;
  /** Whether children are collapsed */
  collapsed: boolean;
  /** Soft-deleted */
  isDeleted: boolean;
  /** Is a top-level page */
  isPage: boolean;
  /** Node display name (for pages, tags, types) */
  name?: string;
  /** Node icon emoji/mdi key */
  icon?: string | null;
  /** Node color */
  color?: string | null;
  /** Class IDs assigned to this node */
  classIds: string[];
  /** Tag IDs */
  tagIds: string[];
  /** Timestamps */
  createdAt: string;
  updatedAt: string;
  /** Optimistic locking version */
  version: number;
}

// ─── Projection types ─────────────────────────────────────────────

/** A projected node that a Lexical editor can render */
export interface ProjectedNode {
  blockId: string;
  depth: number;
  collapsed: boolean;
  visible: boolean;
  nodeType: GraphNodeType;
  contentAST: ContentAST;
  isPage: boolean;
  name?: string;
  icon?: string | null;
  color?: string | null;
  /** Whether this node has children (for bullet/collapse UI) */
  hasChildren: boolean;
  /** Server-side ID for API calls */
  serverId?: number;
  /** Task state if applicable */
  taskState?: string;
  /** Class IDs */
  classIds: string[];
  /** Whether this node is a locked projection root (slice views) */
  isProjectionRoot: boolean;
}

/** Diff operation for reconciliation */
export type ProjectionDiffOp =
  | { type: 'insert'; node: ProjectedNode; atIndex: number }
  | { type: 'remove'; blockId: string }
  | { type: 'move'; blockId: string; toIndex: number }
  | { type: 'update'; blockId: string; changes: Partial<ProjectedNode> };

// ─── Mutation intents ─────────────────────────────────────────────

/** Intent to mutate the graph - emitted by editors, consumed by runtime */
export type MutationIntent =
  | { type: 'update_content'; blockId: string; contentAST: ContentAST }
  | { type: 'split_block'; blockId: string; atOffset: number; newBlockId: string }
  | { type: 'merge_blocks'; sourceBlockId: string; targetBlockId: string }
  | { type: 'create_block'; parentId: string; afterBlockId: string | null; blockId: string; contentAST: ContentAST; nodeType?: GraphNodeType }
  | { type: 'delete_block'; blockId: string }
  | { type: 'move_block'; blockId: string; newParentId: string; afterBlockId: string | null }
  | { type: 'indent_block'; blockId: string }
  | { type: 'outdent_block'; blockId: string }
  | { type: 'move_up'; blockId: string }
  | { type: 'move_down'; blockId: string }
  | { type: 'toggle_collapsed'; blockId: string }
  | { type: 'set_collapsed'; blockId: string; collapsed: boolean }
  | { type: 'reorder_blocks'; parentId: string; orderedBlockIds: string[] }
  | { type: 'set_node_type'; blockId: string; nodeType: GraphNodeType }
  | { type: 'batch'; intents: MutationIntent[] };

// ─── Undo/Redo ────────────────────────────────────────────────────

export interface UndoEntry {
  /** Forward mutation to apply */
  forward: MutationIntent;
  /** Reverse mutation to undo */
  reverse: MutationIntent;
  /** Timestamp */
  timestamp: number;
  /** Optional label */
  label?: string;
}

// ─── Events ───────────────────────────────────────────────────────

export type RuntimeEvent =
  | { type: 'nodes_changed'; blockIds: string[] }
  | { type: 'structure_changed'; parentIds: string[]; source?: 'intent' | 'sync' }
  | { type: 'block_deleted'; blockId: string; serverId?: number }
  | { type: 'projection_invalidated'; projectionId: string }
  | { type: 'undo'; entry: UndoEntry }
  | { type: 'redo'; entry: UndoEntry };

export type RuntimeEventHandler = (event: RuntimeEvent) => void;

// ─── Drag & Drop ──────────────────────────────────────────────────

export interface DragPayload {
  /** The block being dragged */
  blockId: string;
  /** The editor it originated from */
  sourceEditorId: string;
  /** The projected depth when drag started */
  sourceDepth: number;
}

export interface DropTarget {
  /** Target block to drop relative to */
  blockId: string;
  /** Where relative to the target */
  position: 'before' | 'after' | 'child';
  /** The editor receiving the drop */
  targetEditorId: string;
}

// ─── Query/Projection config ──────────────────────────────────────

/** Defines what a projection shows */
export interface ProjectionQuery {
  /** Unique ID for this projection */
  projectionId: string;
  /** Root node to project from */
  rootBlockId: string;
  /** Maximum depth (-1 = unlimited) */
  maxDepth: number;
  /** Whether to include the root node itself */
  includeRoot: boolean;
  /** Filter by node types */
  nodeTypeFilter?: GraphNodeType[];
  /** Sort order */
  sortBy?: 'orderIndex' | 'createdAt' | 'updatedAt' | 'name';
  sortDirection?: 'asc' | 'desc';
}

/** Defines a slice-based projection for arbitrary node sets */
export interface SliceProjectionQuery {
  /** Unique ID for this projection */
  projectionId: string;
  /** Block IDs of the nodes in the slice */
  nodeBlockIds: string[];
  /** How many levels of children to expand (-1 = unlimited, 0 = none) */
  recursiveLevel: number;
  /** Whether to render parent nodes as locked projection roots */
  showParent: boolean;
}

// ─── View modes ───────────────────────────────────────────────────

/** Editor modes for BlockEditor (single-editor projections) */
export type EditorMode = 'list' | 'document';

/** Display modes including card (which uses separate CardView) */
export type ViewMode = 'list' | 'document' | 'table' | 'card' | 'graph';
