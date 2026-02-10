/**
 * Canonical AST → string stringifier for Notees.
 *
 * ONE function — `stringifyAST` — controlled ONLY by `StringifyMode`.
 * No other stringifier may exist.
 *
 * Modes (closed enum):
 *   NODE_MARKDOWN   – preserves node semantics ([[…]], [label]([[…]]))
 *   PLAIN_MARKDOWN  – standard portable Markdown, no [[…]]
 *   TEXT_ONLY        – plain text for search / indexing
 *
 * Node links are resolved recursively with cycle detection.
 */

import type {
  ASTDocument,
  ASTBlockNode,
  ASTInlineNode,
} from '@/types/ast';

// ─── Public types ──────────────────────────────────────────────────

/** Closed enum of stringify modes. */
export const StringifyMode = {
  /** Internal Markdown that preserves node semantics. */
  NODE_MARKDOWN: 'NODE_MARKDOWN',
  /** Standard Markdown without node semantics (for export). */
  PLAIN_MARKDOWN: 'PLAIN_MARKDOWN',
  /** Plain text for search indexing. */
  TEXT_ONLY: 'TEXT_ONLY',
} as const;

export type StringifyMode = (typeof StringifyMode)[keyof typeof StringifyMode];

/**
 * Resolver callback the caller must supply so the stringifier stays
 * side-effect-free and database-agnostic.
 *
 * Given a `link_id` (node_link UUID), return:
 *   - `targetAST`  – the target node's name AST (for recursive stringification)
 *   - `label`      – the custom label from `node_link.name` (may be null)
 *   - `targetId`   – opaque node identifier used only for cycle detection
 *
 * Return `null` if the link cannot be resolved (deleted node, etc.).
 */
export interface NodeLinkResolution {
  readonly targetAST: ASTDocument;
  readonly label: string | null;
  readonly targetId: string;
}

export type NodeLinkResolver = (linkId: string) => NodeLinkResolution | null;

export interface StringifyOptions {
  /** Which rendering mode to use. */
  readonly mode: StringifyMode;
  /** Truncate output to this many characters (applied at the end). */
  readonly maxLength?: number;
  /** Resolver for node links. Required for any AST that contains node_link nodes. */
  readonly resolveNodeLink?: NodeLinkResolver;
  /**
   * Internal — callers should NOT set this.
   * Tracks visited node IDs for cycle detection during recursive resolution.
   */
  readonly _visited?: ReadonlySet<string>;
}

// ─── Entry point ───────────────────────────────────────────────────

/**
 * Stringify a complete AST document.
 *
 * Deterministic. Side-effect-free. No global state.
 */
export function stringifyAST(ast: ASTDocument, options: StringifyOptions): string {
  const result = renderDocument(ast, options);
  if (options.maxLength != null && result.length > options.maxLength) {
    return result.slice(0, options.maxLength);
  }
  return result;
}

// ─── Document / block rendering ────────────────────────────────────

function renderDocument(blocks: ASTBlockNode[], opts: StringifyOptions): string {
  if (blocks.length === 0) return '';

  const isText = opts.mode === StringifyMode.TEXT_ONLY;
  const rendered = blocks.map((b) => renderBlock(b, opts));

  if (isText) {
    // TEXT_ONLY: blocks separated by single space, collapse whitespace at the end.
    return collapseWhitespace(rendered.join(' '));
  }

  // NODE_MARKDOWN / PLAIN_MARKDOWN: double-newline between paragraphs.
  return rendered.join('\n\n');
}

function renderBlock(block: ASTBlockNode, opts: StringifyOptions): string {
  switch (block.type) {
    case 'paragraph':
      return renderInlineSequence(block.children, opts);
    default:
      // Unknown block type — stable placeholder.
      return '';
  }
}

// ─── Inline rendering ──────────────────────────────────────────────

function renderInlineSequence(nodes: ASTInlineNode[], opts: StringifyOptions): string {
  return nodes.map((n) => renderInline(n, opts)).join('');
}

function renderInline(node: ASTInlineNode, opts: StringifyOptions): string {
  switch (node.type) {
    case 'text':
      return node.text;

    case 'hard_break':
      return opts.mode === StringifyMode.TEXT_ONLY ? ' ' : '  \n';

    case 'strong':
      if (opts.mode === StringifyMode.TEXT_ONLY) {
        return renderInlineSequence(node.children, opts);
      }
      return `**${renderInlineSequence(node.children, opts)}**`;

    case 'em':
      if (opts.mode === StringifyMode.TEXT_ONLY) {
        return renderInlineSequence(node.children, opts);
      }
      return `*${renderInlineSequence(node.children, opts)}*`;

    case 'code':
      if (opts.mode === StringifyMode.TEXT_ONLY) {
        return node.text;
      }
      return `\`${node.text}\``;

    case 'strikethrough':
      if (opts.mode === StringifyMode.TEXT_ONLY) {
        return renderInlineSequence(node.children, opts);
      }
      return `~~${renderInlineSequence(node.children, opts)}~~`;

    case 'highlight':
      if (opts.mode === StringifyMode.TEXT_ONLY) {
        return renderInlineSequence(node.children, opts);
      }
      return `==${renderInlineSequence(node.children, opts)}==`;

    case 'underline':
      if (opts.mode === StringifyMode.TEXT_ONLY) {
        return renderInlineSequence(node.children, opts);
      }
      return `__${renderInlineSequence(node.children, opts)}__`;

    case 'external_link': {
      const linkText = renderInlineSequence(node.children, opts);
      if (opts.mode === StringifyMode.TEXT_ONLY) {
        return linkText;
      }
      return `[${linkText}](${node.url})`;
    }

    case 'node_link':
      return renderNodeLink(node.link_id, node.ref_type, opts);

    default:
      // Unknown inline node — return empty string (stable, deterministic).
      return '';
  }
}

// ─── Node link rendering ───────────────────────────────────────────

/**
 * Render a node_link AST node according to the current mode.
 *
 * NODE_MARKDOWN:
 *   Without label: [[resolved_text]]
 *   With label:    [label]([[resolved_text]])
 *
 * PLAIN_MARKDOWN / TEXT_ONLY:
 *   label if present, otherwise resolved node text.
 *
 * Cycle-safe: if the target was already visited, emits "…".
 */
function renderNodeLink(
  linkId: string,
  refType: 'node' | 'class',
  opts: StringifyOptions,
): string {
  const resolver = opts.resolveNodeLink;
  if (!resolver) {
    // No resolver available — emit stable placeholder.
    return opts.mode === StringifyMode.NODE_MARKDOWN ? '[[…]]' : '…';
  }

  const resolution = resolver(linkId);
  if (!resolution) {
    // Link target deleted or unresolvable.
    return opts.mode === StringifyMode.NODE_MARKDOWN ? '[[…]]' : '…';
  }

  const { targetAST, label, targetId } = resolution;

  // ── Cycle detection ──
  const visited = opts._visited ?? new Set<string>();
  if (visited.has(targetId)) {
    return opts.mode === StringifyMode.NODE_MARKDOWN ? '[[…]]' : '…';
  }

  // Build child options with updated visited set.
  const nextVisited = new Set(visited);
  nextVisited.add(targetId);
  const childOpts: StringifyOptions = { ...opts, _visited: nextVisited };

  // Recursively stringify the target node's AST.
  const resolvedText = stringifyAST(targetAST, childOpts);

  switch (opts.mode) {
    case StringifyMode.NODE_MARKDOWN: {
      if (refType === 'class') {
        // Class references: {{resolved_text}} or label
        if (label) {
          return label;
        }
        return `{{${resolvedText}}}`;
      }
      // Node references
      if (label) {
        return `[${label}]([[${resolvedText}]])`;
      }
      return `[[${resolvedText}]]`;
    }

    case StringifyMode.PLAIN_MARKDOWN:
      return label ?? resolvedText;

    case StringifyMode.TEXT_ONLY:
      return label ?? resolvedText;

    default:
      return label ?? resolvedText;
  }
}

// ─── Utilities ─────────────────────────────────────────────────────

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
