/**
 * Node model helpers — structural role (node_type), name derivation,
 * plaintext excerpts. Domain-pure: no IO, no storage.
 */

import type { ContentAst, ContentToken } from "@notees/protocol";

export type NodeType = "page" | "block" | "class";

export interface NodeLike {
  id: string;
  nodeType: NodeType;
  /** @deprecated The node `name` column is being retired (title-is-content):
   * a node's title is its content. Remaining readers are transition-only. */
  name?: string | null;
  contentAst?: ContentAst | null;
  /** System classes (day/month/year drive date display formatting). */
  classIds?: string[];
}

export const DISPLAY_NAME_MAX = 80;

/**
 * Plaintext excerpt of a content token stream (display-name and fallback
 * purposes; the search package owns the full FTS extraction spec).
 * Includes: text runs, typed-link text, mention captured text, math
 * expressions; recurses quotes. Skips: asset_ref/embed_ref/query/whiteboard
 * (structural tokens carry no prose).
 */
export function plainTextExcerpt(ast: ContentAst | null | undefined): string {
  if (!ast) return "";
  const parts: string[] = [];
  const walk = (tokens: readonly ContentToken[]) => {
    for (const token of tokens) {
      switch (token.type) {
        case "text":
        case "typed_link":
          parts.push(token.text);
          break;
        case "mention":
          parts.push(token.displayText ?? token.text);
          break;
        case "math":
          parts.push(token.expression);
          break;
        case "quote":
          walk(token.children);
          break;
        case "hard_break":
          parts.push(" ");
          break;
        default:
          break;
      }
    }
  };
  walk(ast);
  return parts
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Display-name derivation (SCHEMA.md, "title-is-content", 2026-10-01): a
 * node's title IS its own text content — there is no separate name field
 * for any node (pages, blocks AND classes); the display name is the content
 * excerpt; renames never propagate (mentions render the target's current
 * name). Callers fall back to a human "Untitled" label when this returns "".
 *
 * Date nodes (year/month/day system classes) carry the raw YYYYMMDD-style
 * label as their CONTENT (and a content-addressed id); display formats it
 * per the workspace setting shape (default YYYY/MM/DD, zero-padded segments
 * dropped): 20290000 → 2029, 20290600 → 2029/06, 20290627 → 2029/06/27.
 */
export function deriveDisplayName(node: NodeLike): string {
  const excerpt = plainTextExcerpt(node.contentAst).trim();
  if (!excerpt) return "";
  const dateFormatted = formatDateNodeName(excerpt, node.classIds);
  return (dateFormatted ?? excerpt).slice(0, DISPLAY_NAME_MAX);
}

/**
 * Flatten any token stream to text-only content (pages and classes carry
 * text-only content — SCHEMA.md "title-is-content"). Used when a block is
 * promoted to a page/class and by the applier's text-only constraint.
 * Inline rich tokens (mentions, chips, links, marks) fold into their plain
 * text; block-scale structural widgets (whiteboard, query) survive as
 * tokens — they are displays, not prose, and a whiteboard page is a real
 * surface (the flatten would otherwise destroy it).
 */
export function stringifyContentAst(ast: ContentAst | null | undefined): ContentAst {
  if (!ast) return [];
  const out: ContentAst = [];
  for (const token of ast) {
    if (token.type === "whiteboard" || token.type === "query") {
      out.push(token);
      continue;
    }
  }
  const text = plainTextExcerpt(ast).trim();
  if (text !== "") out.unshift({ type: "text", text });
  return out;
}

/** True when every token is plain text or a structural widget (pages/classes only). */
export function isTextOnlyContent(ast: unknown): boolean {
  if (!Array.isArray(ast)) return false;
  return ast.every((token) => {
    if (typeof token !== "object" || token === null) return false;
    const type = (token as { type?: unknown }).type;
    if (type === "whiteboard" || type === "query") return true;
    return type === "text" && typeof (token as { text?: unknown }).text === "string";
  });
}

const DATE_CLASS_IDS = new Set(["00000000-0000-0000-0001-000000000003", "00000000-0000-0000-0001-000000000004", "00000000-0000-0000-0001-000000000005"]);

/**
 * Format a raw date-node name; null when the name is not the YYYYMMDD shape.
 * The class check is deliberately NOT required: migrated date pages may lack
 * the day/month/year classes, and an 8-digit name is unambiguous.
 */
export function formatDateNodeName(name: string, classIds?: readonly string[]): string | null {
  void classIds; // retained in the signature for callers that have it
  const digits = name.replace(/\D/g, "");
  if (!/^\d{8}$/.test(digits)) return null;
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  if (month === "00") return year;
  if (day === "00") return `${year}/${month}`;
  return `${year}/${month}/${day}`;
}

export function isPage(node: Pick<NodeLike, "nodeType">): boolean {
  return node.nodeType === "page";
}

export function isClass(node: Pick<NodeLike, "nodeType">): boolean {
  return node.nodeType === "class";
}

export function isBlock(node: Pick<NodeLike, "nodeType">): boolean {
  return node.nodeType === "block";
}
