/**
 * AST builder helpers for constructing AST documents programmatically.
 *
 * These are the ONLY sanctioned way to build AST nodes in application code.
 * They enforce correct typing and make AST construction concise.
 *
 * For parsing text into AST, use `parseAST(input, mode)`:
 *   - ParseMode.JSON      — deserialize JSON string (default)
 *   - ParseMode.PLAIN     — wrap plain text as a single text node
 *   - ParseMode.MARKDOWN  — parse inline Markdown formatting
 *
 * For HTML → AST, use `domToAST()` from `astDom.ts` (browser DOM only).
 */
import type {
  ASTDocument,
  ASTParagraph,
  ASTHeading,
  ASTWhiteboard,
  ASTText,
  ASTHardBreak,
  ASTCode,
  ASTNodeLink,
  ASTStrong,
  ASTEm,
  ASTStrikethrough,
  ASTHighlight,
  ASTUnderline,
  ASTExternalLink,
  ASTInlineNode,
} from '@/types/ast';
import type { WhiteboardData } from '@/types/whiteboard';

// Re-export types for convenience
export type { ASTDocument, ASTInlineNode };

// ─── Parse modes ───────────────────────────────────────────────────

/**
 * Closed enum of parse modes (string → AST).
 *
 * Mirrors the backend's `ParseMode` exactly.
 */
export const ParseMode = {
  /** Deserialize a JSON string (or pass through a list). Default. */
  JSON: 'JSON',
  /** Wrap plain text as-is in a single text node (no formatting). */
  PLAIN: 'PLAIN',
  /** Parse inline Markdown: **bold**, *italic*, ~~strike~~, ==highlight==, __underline__, [text](url). Backtick-wrapped code like `code` is kept as plain text. */
  MARKDOWN: 'MARKDOWN',
} as const;

export type ParseMode = (typeof ParseMode)[keyof typeof ParseMode];

// ─── Leaf builders ─────────────────────────────────────────────────

export function text(t: string): ASTText {
  return { type: 'text', text: t };
}

export function hardBreak(): ASTHardBreak {
  return { type: 'hard_break' };
}

export function code(codeText: string): ASTCode {
  return { type: 'code', text: codeText };
}

export function nodeLink(linkId: string, refType: 'node' | 'class' = 'node', label?: string | null): ASTNodeLink {
  const link: ASTNodeLink = { type: 'node_link', link_id: linkId, ref_type: refType };
  if (label !== undefined && label !== null) {
    (link as any).label = label;
  }
  return link;
}

// ─── Link ID utilities ─────────────────────────────────────────────

/**
 * Parsed components of a compound link_id ("nodeUuid:linkUuid").
 */
export interface ParsedLinkId {
  /** The target node's UUID (informational — used for display/damage control) */
  nodeUuid: string;
  /** The unique link-instance UUID (stored in node_link table) */
  linkUuid: string | undefined;
}

/**
 * Build a compound link_id string: "nodeUuid:linkUuid".
 */
export function buildLinkId(nodeUuid: string, linkUuid: string): string {
  return `${nodeUuid}:${linkUuid}`;
}

/**
 * Parse a compound link_id ("nodeUuid:linkUuid") into its parts.
 *
 * Format: "nodeUuid:linkUuid"
 *   - nodeUuid: target node UUID (for display / damage control)
 *   - linkUuid: unique per-link-instance UUID
 *
 * Legacy format "nodeId:linkUuid" (numeric first part) is also handled.
 */
export function parseLinkId(linkId: string): ParsedLinkId {
  const colonIdx = linkId.indexOf(':');
  if (colonIdx > 0) {
    return {
      nodeUuid: linkId.substring(0, colonIdx),
      linkUuid: linkId.substring(colonIdx + 1),
    };
  }
  return { nodeUuid: linkId, linkUuid: undefined };
}

// ─── Mark builders ─────────────────────────────────────────────────

export function strong(...children: ASTInlineNode[]): ASTStrong {
  return { type: 'strong', children };
}

export function em(...children: ASTInlineNode[]): ASTEm {
  return { type: 'em', children };
}

export function strikethrough(...children: ASTInlineNode[]): ASTStrikethrough {
  return { type: 'strikethrough', children };
}

export function highlight(...children: ASTInlineNode[]): ASTHighlight {
  return { type: 'highlight', children };
}

export function underline(...children: ASTInlineNode[]): ASTUnderline {
  return { type: 'underline', children };
}

export function externalLink(url: string, ...children: ASTInlineNode[]): ASTExternalLink {
  return { type: 'external_link', url, children };
}

// ─── Block builders ────────────────────────────────────────────────

export function paragraph(...children: ASTInlineNode[]): ASTParagraph {
  return { type: 'paragraph', children };
}
export function heading(...children: ASTInlineNode[]): ASTHeading {
  return { type: 'heading', children };
}
export function whiteboard(title: string, data: WhiteboardData): ASTWhiteboard {
  return { type: 'whiteboard', title, data };
}
/**
 * Build a complete document from paragraphs.
 * If called with inline nodes directly, wraps them in a single paragraph.
 */
export function doc(...blocks: ASTParagraph[]): ASTDocument {
  return blocks;
}

/**
 * Convenience: build a single-paragraph document from inline nodes.
 */
export function inlineDoc(...children: ASTInlineNode[]): ASTDocument {
  return [paragraph(...children)];
}

// ─── AST parsing ───────────────────────────────────────────────────

/**
 * Parse input into a validated ASTDocument.
 *
 * Modes:
 *   - `ParseMode.JSON` (default): Deserialize a JSON string or validate an array.
 *   - `ParseMode.PLAIN`: Wrap plain text as-is in a paragraph (no formatting).
 *   - `ParseMode.MARKDOWN`: Parse inline Markdown into AST nodes.
 *
 * @param input — JSON string, array, or plain text depending on mode.
 * @param mode  — How to interpret the input. Defaults to `ParseMode.JSON`.
 */
export function parseAST(input: unknown, mode: ParseMode = ParseMode.JSON): ASTDocument {
  switch (mode) {
    case ParseMode.JSON:
      return parseJSON(input);

    case ParseMode.PLAIN: {
      if (typeof input !== 'string' || !input) return [];
      return [paragraph(text(input))];
    }

    case ParseMode.MARKDOWN: {
      if (typeof input !== 'string' || !input) return [];
      return parseMdDocument(input);
    }

    default:
      return [];
  }
}

// ── JSON parsing ───────────────────────────────────────────────────

function parseJSON(input: unknown): ASTDocument {
  if (typeof input === 'string') {
    if (!input) return [];
    try {
      const parsed = JSON.parse(input);
      if (!Array.isArray(parsed)) return [];
      return validateDocument(parsed);
    } catch {
      // Not valid JSON — treat as plain text so content is never silently lost
      return [paragraph(text(input))];
    }
  }
  if (Array.isArray(input)) {
    return validateDocument(input);
  }
  return [];
}

/**
 * Validate that a parsed value is a well-formed ASTDocument.
 * Returns the input if valid, otherwise returns an empty document.
 */
function validateDocument(doc: unknown): ASTDocument {
  if (!Array.isArray(doc)) return [];
  for (const block of doc) {
    if (typeof block !== 'object' || block === null || !('type' in block)) {
      return [];
    }
  }
  return doc as ASTDocument;
}

// ── Markdown parsing ───────────────────────────────────────────────

/**
 * Regex matching inline Markdown patterns.
 *
 * Order matters — longer/more specific patterns first:
 *   `code`  →  ***bold italic***  →  **bold**  →  *italic*
 *   ~~strike~~  →  ==highlight==  →  __underline__  →  [text](url)
 */
/**
 * Build a fresh inline-Markdown regex.
 *
 * Each call to `parseMdInline` needs its own RegExp instance because
 * `.exec()` on a global regex mutates `lastIndex`.  Sharing a single
 * module-level regex across recursive calls (bold inner content, etc.)
 * corrupts the outer call's position → infinite re-matching → OOM.
 */
function makeMdInlineRE(): RegExp {
  return /(?<code>`[^`]+`)|(?<bold_italic>\*\*\*(?<bi>.+?)\*\*\*)|(?<bold>\*\*(?<b>.+?)\*\*)|(?<italic>\*(?<i>[^*]+?)\*)|(?<strike>~~(?<s>.+?)~~)|(?<highlight>==(?<h>.+?)==)|(?<underline>__(?<u>.+?)__)|(?<link>\[(?<lt>[^\]]+)\]\((?<lu>[^)]+)\))/g;
}

function parseMdDocument(input: string): ASTDocument {
  const children = parseMdInline(input);
  if (children.length === 0) return [];
  return [paragraph(...children)];
}

function parseMdInline(input: string): ASTInlineNode[] {
  const nodes: ASTInlineNode[] = [];
  let pos = 0;

  // Each invocation gets its own regex so recursive calls
  // (for bold/italic inner content) don't corrupt our lastIndex.
  const re = makeMdInlineRE();

  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const start = m.index;

    // Emit plain text before this match
    if (start > pos) {
      nodes.push(text(input.slice(pos, start)));
    }

    if (m.groups?.code) {
      // Inline code: strip backticks and emit a proper code AST node
      nodes.push(code(m.groups.code.slice(1, -1)));
    } else if (m.groups?.bold_italic) {
      const inner = m.groups.bi!;
      nodes.push(strong(em(text(inner))));
    } else if (m.groups?.bold) {
      const inner = m.groups.b!;
      nodes.push(strong(...parseMdInline(inner)));
    } else if (m.groups?.italic) {
      const inner = m.groups.i!;
      nodes.push(em(...parseMdInline(inner)));
    } else if (m.groups?.strike) {
      const inner = m.groups.s!;
      nodes.push(strikethrough(...parseMdInline(inner)));
    } else if (m.groups?.highlight) {
      const inner = m.groups.h!;
      nodes.push(highlight(...parseMdInline(inner)));
    } else if (m.groups?.underline) {
      const inner = m.groups.u!;
      nodes.push(underline(...parseMdInline(inner)));
    } else if (m.groups?.link) {
      const linkText = m.groups.lt!;
      const url = m.groups.lu!;
      nodes.push(externalLink(url, text(linkText)));
    }

    pos = m.index + m[0].length;
  }

  // Trailing text
  if (pos < input.length) {
    nodes.push(text(input.slice(pos)));
  }

  return nodes;
}

// ── Markdown conversion within existing AST ────────────────────────

/**
 * Quick-check regex: does a string contain any markdown syntax?
 * Used to skip the full conversion when there's nothing to convert.
 */
const MD_QUICK_CHECK = /[*~`=]|\[.+\]\(/;

/**
 * Walk an ASTDocument and convert markdown syntax inside text nodes
 * to proper AST mark nodes.
 *
 * Non-text nodes (node_links, existing marks, etc.) are preserved.
 * Already-formatted content is untouched — only plain `text` nodes
 * that contain markdown delimiters are expanded.
 *
 * Returns a NEW document (no mutation).
 */
export function convertMarkdownInAST(ast: ASTDocument): ASTDocument {
  if (!ast || ast.length === 0) return ast;

  let changed = false;
  const result = ast.map((block) => {
    if (block.type !== 'paragraph' && block.type !== 'heading') return block;

    const newChildren = expandInlineNodes(block.children);
    if (newChildren !== block.children) {
      changed = true;
      return { ...block, children: newChildren };
    }
    return block;
  });

  return changed ? result : ast;
}

/**
 * Process an array of inline nodes: expand markdown in text nodes,
 * recurse into mark nodes that have children.
 */
function expandInlineNodes(nodes: readonly ASTInlineNode[]): ASTInlineNode[] {
  let changed = false;
  const result: ASTInlineNode[] = [];

  for (const node of nodes) {
    if (node.type === 'text' && MD_QUICK_CHECK.test(node.text)) {
      const expanded = parseMdInline(node.text);
      // If parseMdInline returns a single text node with the same content,
      // no markdown was actually found.
      if (expanded.length === 1 && expanded[0].type === 'text' && (expanded[0] as ASTText).text === node.text) {
        result.push(node);
      } else {
        changed = true;
        result.push(...expanded);
      }
    } else if ('children' in node && Array.isArray((node as ASTStrong).children)) {
      // Recurse into mark nodes (strong, em, strikethrough, highlight, external_link)
      const markNode = node as ASTStrong; // any mark with children
      const newChildren = expandInlineNodes(markNode.children);
      if (newChildren !== markNode.children) {
        changed = true;
        result.push({ ...node, children: newChildren } as ASTInlineNode);
      } else {
        result.push(node);
      }
    } else {
      // node_link, hard_break, code — pass through
      result.push(node);
    }
  }

  return changed ? result : (nodes as ASTInlineNode[]);
}
