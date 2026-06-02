/**
 * Rich-text AST type definitions for Notees.
 *
 * The AST stored in each node's `name` column is the SINGLE SOURCE OF TRUTH.
 * Markdown is lossy and used only for display/export.
 * There is no separate title field — display strings are derived from the AST.
 *
 * Pages: `name` holds the page-title AST.
 * Blocks: `name` holds the block-content AST.
 * Child blocks are separate nodes — they are NEVER embedded in a parent's AST.
 */

import type { WhiteboardData } from './whiteboard';
import type { QueryAST } from './queryAST';

// ─── Leaf nodes ────────────────────────────────────────────────────

/** Plain text. */
export interface ASTText {
  readonly type: 'text';
  readonly text: string;
}

/** Hard line break (Shift+Enter). */
export interface ASTHardBreak {
  readonly type: 'hard_break';
}

/** Inline code span (backtick-wrapped). Stored without backticks. */
export interface ASTCode {
  readonly type: 'code';
  readonly text: string;
}

/** Inline math formula (LaTeX). Stored without delimiters. */
export interface ASTMath {
  readonly type: 'math';
  readonly expression: string;
  readonly displayMode?: boolean;
}

/**
 * Inline node link.
 *
 * `link_id` is the UUID of the row in the `node_link` table, NOT the
 * target node's UUID. The link table stores source, target, and an
 * optional custom label (`name` column on node_link).
 *
 * `ref_type` distinguishes rendering:
 *   - 'node' — regular page/block reference
 *   - 'class' — class reference that keeps text inline
 *
 * `label` is an optional custom display text (e.g., [custom label]([[uuid]]))
 * stored inline in the AST.
 */
export interface ASTNodeLink {
  readonly type: 'node_link';
  readonly link_id: string;
  /** 'node' — regular reference, 'class' — class reference, 'embed' — full node embed portal */
  readonly ref_type: 'node' | 'class' | 'embed';
  readonly label?: string | null;
}

/** Preserved reference to a node that no longer exists.
 *  Keeps the original link_id (and optional label) so the UUID is not lost.
 */
export interface ASTBrokenLink {
  readonly type: 'broken_link';
  readonly link_id: string;
  readonly label?: string | null;
}

// ─── Mark (formatting) nodes ───────────────────────────────────────

export interface ASTStrong {
  readonly type: 'strong';
  readonly children: ASTInlineNode[];
}

export interface ASTEm {
  readonly type: 'em';
  readonly children: ASTInlineNode[];
}

export interface ASTStrikethrough {
  readonly type: 'strikethrough';
  readonly children: ASTInlineNode[];
}

export interface ASTHighlight {
  readonly type: 'highlight';
  readonly children: ASTInlineNode[];
}

export interface ASTUnderline {
  readonly type: 'underline';
  readonly children: ASTInlineNode[];
}

// ─── External link ─────────────────────────────────────────────────

export interface ASTExternalLink {
  readonly type: 'external_link';
  readonly url: string;
  readonly children: ASTInlineNode[];
}

// ─── Block-level nodes ─────────────────────────────────────────────

export interface ASTParagraph {
  readonly type: 'paragraph';
  readonly children: ASTInlineNode[];
}

/**
 * Heading block. Semantically marks a block as a section header.
 * The rendered heading level (h1–h6) is computed from the block's
 * hierarchy depth in the current view — it is NOT stored in the AST.
 */
export interface ASTHeading {
  readonly type: 'heading';
  readonly level: number;
  readonly children: ASTInlineNode[];
}

/**
 * Whiteboard block. Stores layout data inline in the AST.
 *
 * A whiteboard node's `name` is:
 *   `[
 *     { type: 'paragraph', children: [{ type: 'text', text: 'Title' }] },
 *     { type: 'whiteboard', data: { ...WhiteboardData } }
 *   ]`
 *
 * The title is stored as a normal paragraph block (children approach).
 * `data` holds the full WhiteboardData (viewport, elements, grid, background).
 */
export interface ASTWhiteboard {
  readonly type: 'whiteboard';
  readonly data: WhiteboardData;
  readonly children?: ASTInlineNode[];
  readonly title?: string;
}

/**
 * Query block. Stores a QueryAST inline in the node's `name` field.
 *
 * A query node's `name` is:
 *   `[
 *     { type: 'paragraph', children: [{ type: 'text', text: 'Title' }] },
 *     { type: 'query', data: { ...QueryAST } }
 *   ]`
 *
 * The title is stored as a normal paragraph block (children approach).
 * `data` holds the full QueryAST.
 */
export interface ASTQuery {
  readonly type: 'query';
  readonly data: QueryAST;
  readonly children?: ASTInlineNode[];
}

// ─── Union types ───────────────────────────────────────────────────

/** Any node that can appear inside a paragraph or formatting mark. */
export type ASTInlineNode =
  | ASTText
  | ASTHardBreak
  | ASTCode
  | ASTMath
  | ASTNodeLink
  | ASTBrokenLink
  | ASTStrong
  | ASTEm
  | ASTStrikethrough
  | ASTHighlight
  | ASTUnderline
  | ASTExternalLink;

/** Top-level node. A `name` column stores an array of these. */
export type ASTBlockNode = ASTParagraph | ASTHeading | ASTWhiteboard | ASTQuery;

/**
 * Returns true if the block node is a heading.
 */
export function isHeadingBlock(node: ASTBlockNode): node is ASTHeading {
  return node.type === 'heading';
}

/**
 * Returns true if the block node is a whiteboard.
 */
export function isWhiteboardBlock(node: ASTBlockNode): node is ASTWhiteboard {
  return node.type === 'whiteboard';
}

/**
 * Returns true if the block node is a query.
 */
export function isQueryBlock(node: ASTBlockNode): node is ASTQuery {
  return node.type === 'query';
}

/**
 * The value stored in node.name (JSON-serialized).
 *
 * An empty name is represented as `[]`.
 * A simple one-liner is `[{ type: 'paragraph', children: [...] }]`.
 */
export type ASTDocument = ASTBlockNode[];

// ─── Helpers ───────────────────────────────────────────────────────

/** Type guard: is the node a leaf (no children array)? */
export function isLeafNode(node: ASTInlineNode): node is ASTText | ASTHardBreak | ASTCode | ASTMath | ASTNodeLink | ASTBrokenLink {
  return node.type === 'text' || node.type === 'hard_break' || node.type === 'code' || node.type === 'math' || node.type === 'node_link' || node.type === 'broken_link';
}
