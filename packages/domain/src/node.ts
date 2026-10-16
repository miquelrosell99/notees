/**
 * Node model helpers — the Revision-12 embedding model (is_class /
 * is_embedded), name derivation, plaintext excerpts. Domain-pure: no
 * IO, no storage.
 *
 * Render cascade (SCHEMA.md): is_class → ClassView; parentless → document
 * chrome (the flag unread); otherwise the flag decides — is_embedded = 0
 * (the standalone claim) puts the node in the parent's main-children zone
 * + document chrome when zoomed, is_embedded = 1 (the default) keeps it in
 * the inline body + block chrome. The flag is only EFFECTIVE under a page
 * parent (owner ruling 2026-10-15): a parented node renders with document
 * chrome ONLY when is_embedded = 0 AND its parent also renders with
 * document chrome — classes are not pages (ClassView), so a standalone
 * claim under a class or an embedded block parent is inert. The store
 * enforces the invariant write-time; render assumes it.
 */

import type { ContentAst, ContentToken } from "@notees/protocol";

import { dateNodeDisplayLabel, parseDateNodeId } from "./dates.js";

export interface NodeLike {
  id: string;
  /** Class identity bit — the ONLY identity marker (classes are always
   * roots). Accepts the store row shape (0/1) too. */
  isClass?: boolean | number;
  /** Embedding flag for parented non-class nodes (Revision 12): false/absent
   * = a standalone structural element — the parent's main-children zone
   * (the Page role); true = embedded in the parent's body (the Block role,
   * the default). Unread for parentless nodes and classes. */
  isEmbedded?: boolean | number;
  /** Tree placement; null/absent = workspace root. */
  parentId?: string | null;
  /** @deprecated The node `name` column is being retired (title-is-content):
   * a node's title is its content. Remaining readers are transition-only. */
  name?: string | null;
  contentAst?: ContentAst | null;
  /** System classes (day/month/year drive date display formatting). */
  classIds?: string[];
}

export const DISPLAY_NAME_MAX = 80;

/**
 * The node's FULL title — the same derivation as deriveDisplayName
 * (title-is-content excerpt + the date-node formatting branch) WITHOUT the
 * display budget slice. Dense chrome (breadcrumbs, pickers, sidebar rows)
 * reads the capped deriveDisplayName; node links and mention chips render
 * the complete name (owner ruling: a link must read as the page's whole
 * title, never a truncation), so they read this.
 *
 * Date formatting applies ONLY to date nodes (owner ruling 2026-10-08): a
 * deterministic date id (the year/month/day chain) formats from the id, and
 * a compact YYYYMMDD-style excerpt formats only when the node carries a
 * date class — an 8-digit title on an ordinary page stays literal.
 * `resolveClassName` includes class chips' resolved labels in the excerpt
 * (optional — the pure default drops bare chips, see plainTextExcerpt).
 */
export function fullTitleOf(
  node: NodeLike,
  resolveClassName?: (classId: string) => string | null,
): string {
  const fromId = parseDateNodeId(node.id);
  if (fromId !== null) return dateNodeDisplayLabel(fromId, fromId.precision);
  const excerpt = plainTextExcerpt(node.contentAst, resolveClassName).trim();
  if (!excerpt) return "";
  const dateFormatted = formatDateNodeName(excerpt, node.classIds);
  return dateFormatted ?? excerpt;
}

/**
 * Plaintext excerpt of a content token stream (display-name and fallback
 * purposes; the search package owns the full FTS extraction spec).
 * Includes: text runs, typed-link text, mention captured text, a class
 * chip's label, math expressions; recurses quotes and headings. Skips:
 * asset_ref/embed_ref/query/whiteboard (structural tokens carry no prose).
 *
 * A class chip's label is the class's CURRENT name — graph state this pure
 * helper cannot resolve on its own. Callers with client access pass
 * `resolveClassName`; a chip carrying its own one-off `displayText` wins
 * over the resolved name. Without a resolver a bare chip excerpts to ""
 * (the caller falls back to the resolved class display name).
 */
export function plainTextExcerpt(
  ast: ContentAst | null | undefined,
  resolveClassName?: (classId: string) => string | null,
): string {
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
        case "class_link": {
          const label = token.displayText ?? (resolveClassName?.(token.classId) ?? null);
          if (label !== null) parts.push(label);
          break;
        }
        case "math":
          parts.push(token.expression);
          break;
        case "quote":
        case "heading":
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
 * Date formatting applies ONLY to date-classed nodes (owner ruling
 * 2026-10-08) — see fullTitleOf.
 *
 * The result is capped at DISPLAY_NAME_MAX — the dense-chrome budget.
 * Node links/mention chips read fullTitleOf instead (the complete title).
 * Pass `resolveClassName` to include class chips' resolved labels in the
 * excerpt (flattened chrome: tab title, table cells); without it a bare
 * chip contributes nothing.
 */
export function deriveDisplayName(
  node: NodeLike,
  resolveClassName?: (classId: string) => string | null,
): string {
  return fullTitleOf(node, resolveClassName).slice(0, DISPLAY_NAME_MAX);
}

/**
 * Flatten any token stream to text-only content (pages and classes carry
 * text-only content — SCHEMA.md "title-is-content"). Used when a block is
 * promoted to a page/class and by the applier's text-only constraint.
 * Inline rich tokens (mentions, chips, links, marks) fold into their plain
 * text; block-scale structural widgets (whiteboard, query, code_block)
 * survive as tokens — they are displays/source, not prose, and
 * a whiteboard/code page is a real surface (the flatten would otherwise
 * destroy it). `hr` is deliberately NOT a survivor: it carries
 * no prose.
 */
export function stringifyContentAst(ast: ContentAst | null | undefined): ContentAst {
  if (!ast) return [];
  const out: ContentAst = [];
  for (const token of ast) {
    if (token.type === "whiteboard" || token.type === "query" || token.type === "code_block") {
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
    if (type === "whiteboard" || type === "query" || type === "code_block") return true;
    return type === "text" && typeof (token as { text?: unknown }).text === "string";
  });
}

const DATE_CLASS_IDS = new Set(["00000000-0000-0000-0001-000000000003", "00000000-0000-0000-0001-000000000004", "00000000-0000-0000-0001-000000000005"]);

/**
 * Format a raw date-node name; null when the name is not the YYYYMMDD shape
 * OR the node does not carry a date class (year/month/day). The class check
 * is the owner ruling (2026-10-08): date formatting applies only to
 * date-classed nodes — an ordinary page whose title happens to be 8 digits
 * keeps its literal title everywhere. Nodes with a deterministic date id
 * never reach this branch (fullTitleOf formats from the id first).
 */
export function formatDateNodeName(name: string, classIds?: readonly string[]): string | null {
  if (classIds?.some((id) => DATE_CLASS_IDS.has(id)) !== true) return null;
  const digits = name.replace(/\D/g, "");
  if (!/^\d{8}$/.test(digits)) return null;
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  if (month === "00") return year;
  if (day === "00") return `${year}/${month}`;
  return `${year}/${month}/${day}`;
}

/** Class identity bit (Revision 11): true for class nodes — the only
 * identity marker; placement alone never makes a node a class. */
export function isClassNode(node: Pick<NodeLike, "isClass">): boolean {
  return !!node.isClass;
}

/**
 * Document-chrome predicate (the Page role): ClassView rows excluded (first
 * cascade branch), parentless non-class rows render as documents regardless
 * of the flag (second branch), and a parented row renders with document
 * chrome exactly when is_embedded = 0 (the standalone claim) AND its parent
 * also renders with document chrome (owner ruling 2026-10-15 — the
 * parent-page condition; a class or embedded-block parent makes the claim
 * inert).
 *
 * `parent` is the parent row's render facts, when the caller has them. The
 * store enforces the invariant write-time (a standalone claim under a
 * non-page parent is never stored), so an omitted/absent parent means "not
 * at hand" and the flag is trusted — deeper ancestry than one level rides
 * the same invariant.
 */
export function rendersWithDocumentChrome(
  node: Pick<NodeLike, "isClass" | "parentId" | "isEmbedded">,
  parent?: Pick<NodeLike, "isClass" | "parentId" | "isEmbedded"> | null,
): boolean {
  if (node.isClass) return false;
  if (node.parentId == null) return true;
  if (node.isEmbedded !== false && node.isEmbedded !== 0) return false;
  if (parent == null) return true;
  return rendersWithDocumentChrome(parent);
}

/**
 * Inline-block predicate (the Block role): a parented non-class node that
 * does NOT render with document chrome — embedded in the parent's body, or
 * a standalone claim inert under a non-page parent.
 */
export function rendersAsInlineBlock(
  node: Pick<NodeLike, "isClass" | "parentId" | "isEmbedded">,
  parent?: Pick<NodeLike, "isClass" | "parentId" | "isEmbedded"> | null,
): boolean {
  return !node.isClass && node.parentId != null && !rendersWithDocumentChrome(node, parent);
}
