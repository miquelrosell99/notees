/**
 * Node model helpers — structural role (node_type), name derivation,
 * plaintext excerpts. Domain-pure: no IO, no storage.
 */

import type { ContentAst, ContentToken } from "@notees/protocol";

export type NodeType = "page" | "block" | "class";

export interface NodeLike {
  id: string;
  nodeType: NodeType;
  name?: string | null;
  contentAst?: ContentAst | null;
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
 * Display-name derivation (SCHEMA.md, decided 2026-09-26): a stored `name`
 * wins; otherwise blocks derive from their content excerpt; renames never
 * propagate (mentions render the target's current name). Callers fall back
 * to the node id when this returns "".
 */
export function deriveDisplayName(node: NodeLike): string {
  const name = node.name?.trim();
  if (name) return name.slice(0, DISPLAY_NAME_MAX);
  const excerpt = plainTextExcerpt(node.contentAst);
  if (excerpt) return excerpt.slice(0, DISPLAY_NAME_MAX);
  return "";
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
