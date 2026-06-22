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
  ASTDateRange,
} from '@/types/ast';
import { formatDateRange } from '@/utils/dateRange';

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
 *   - `label`      – optional fallback label (may be null; AST label takes precedence)
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
    case 'heading':
      // Heading level is computed at render time from block depth; here we
      // just emit the inline content. Export and markdown modes add # prefix.
      return renderInlineSequence(block.children, opts);
    case 'whiteboard':
      // Whiteboard blocks render as their title + content for text/search purposes.
      {
        const title = block.title || '';
        const elements = block.data?.elements || [];
        const textParts: string[] = [];
        
        // Sort elements by Y then X to maintain logical reading order
        const sortedElements = [...elements].sort((a, b) => {
          // Group by rows (fuzzy Y sort): if Y difference is small, treat as same row
          if (Math.abs(a.y - b.y) > 20) return a.y - b.y;
          return a.x - b.x;
        });
        
        for (const el of sortedElements) {
          // Extract text from text and shape elements
          if ((el.type === 'text' || el.type === 'shape') && 'text' in el && el.text) {
             textParts.push(el.text);
          }
        }
        
        const contentText = textParts.join(' ');
        
        if (title && contentText) {
          return `${title} (${contentText})`;
        }
        
        return title || contentText;
      }
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

    case 'code':
      if (opts.mode === StringifyMode.TEXT_ONLY) {
        return node.text;
      }
      return `\`${node.text}\``;

    case 'math':
      if (opts.mode === StringifyMode.TEXT_ONLY) {
        return node.expression;
      }
      return node.displayMode ? `$$${node.expression}$$` : `$${node.expression}$`;

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
      return renderNodeLink(node.link_id, node.ref_type, opts, node.label);

    case 'broken_link': {
      const text = node.label || node.link_id.split(':')[0] || '';
      if (opts.mode === StringifyMode.TEXT_ONLY) {
        return text;
      }
      return `[${text}]([broken])`;
    }

    case 'date_range': {
      const label = node.label || formatDateRange(node as ASTDateRange);
      if (opts.mode === StringifyMode.TEXT_ONLY) {
        return label;
      }
      return `[${label}]([date-range])`;
    }

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
 *
 * @param astLabel - label from the AST node itself (single source of truth)
 */
function renderNodeLink(
  linkId: string,
  refType: 'node' | 'class' | 'embed' | 'user',
  opts: StringifyOptions,
  astLabel?: string | null,
): string {
  const resolver = opts.resolveNodeLink;
  if (!resolver) {
    // No resolver available — use AST label if present, otherwise stable placeholder.
    if (astLabel) return opts.mode === StringifyMode.NODE_MARKDOWN ? `[${astLabel}]([[…]])` : astLabel;
    return opts.mode === StringifyMode.NODE_MARKDOWN ? '[[…]]' : '…';
  }

  const resolution = resolver(linkId);
  if (!resolution) {
    // Link target deleted or unresolvable — use AST label if present.
    if (astLabel) return opts.mode === StringifyMode.NODE_MARKDOWN ? `[${astLabel}]([[…]])` : astLabel;
    return opts.mode === StringifyMode.NODE_MARKDOWN ? '[[…]]' : '…';
  }

  // AST label takes precedence over DB label
  const label = astLabel ?? resolution.label;
  const { targetAST, targetId } = resolution;

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
      if (refType === 'user') {
        return `[@${label ?? resolvedText}](@user)`;
      }
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
      return refType === 'user' ? `@${label ?? resolvedText}` : (label ?? resolvedText);

    case StringifyMode.TEXT_ONLY:
      return refType === 'user' ? `@${label ?? resolvedText}` : (label ?? resolvedText);

    default:
      return label ?? resolvedText;
  }
}

// ─── Utilities ─────────────────────────────────────────────────────

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
