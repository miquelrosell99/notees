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
 */
export interface ASTNodeLink {
  readonly type: 'node_link';
  readonly link_id: string;
  readonly ref_type: 'node' | 'class';
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

export interface ASTCode {
  readonly type: 'code';
  readonly text: string;
}

export interface ASTStrikethrough {
  readonly type: 'strikethrough';
  readonly children: ASTInlineNode[];
}

export interface ASTHighlight {
  readonly type: 'highlight';
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

// ─── Union types ───────────────────────────────────────────────────

/** Any node that can appear inside a paragraph or formatting mark. */
export type ASTInlineNode =
  | ASTText
  | ASTHardBreak
  | ASTNodeLink
  | ASTStrong
  | ASTEm
  | ASTCode
  | ASTStrikethrough
  | ASTHighlight
  | ASTExternalLink;

/** Top-level node. A `name` column stores an array of these. */
export type ASTBlockNode = ASTParagraph;

/**
 * The value stored in node.name (JSON-serialized).
 *
 * An empty name is represented as `[]`.
 * A simple one-liner is `[{ type: 'paragraph', children: [...] }]`.
 */
export type ASTDocument = ASTBlockNode[];

// ─── Helpers ───────────────────────────────────────────────────────

/** Type guard: is the node a leaf (no children array)? */
export function isLeafNode(node: ASTInlineNode): node is ASTText | ASTHardBreak | ASTNodeLink | ASTCode {
  return node.type === 'text' || node.type === 'hard_break' || node.type === 'node_link' || node.type === 'code';
}
