/**
 * prose ⇄ contentAst — the plain-text editing projection of a block's token
 * stream (SCHEMA.md "Content grammar").
 *
 * The editor edits BLOCK PROSE as plain text: the concatenation of the
 * `text` values of text / typed_link / mention tokens, with `hard_break`
 * projected to "\n" (its shift+Enter line jump) so the round trip is lossless
 * for plain blocks. Marks and non-prose tokens are read-only chrome in this
 * slice: editing a block whose contentAst contains tokens the prose
 * projection cannot represent flattens them on save — the caller guards by
 * skipping saves whose draft equals the current prose (BlockTextEditor.flush),
 * so merely touching a mention/chip block without changing its text is free.
 *
 * Class chips carry no captured text on the wire (only an optional
 * displayText): in the editor they render as label-resolved pills
 * (contenteditable=false), so their LABEL counts toward the prose length to
 * keep `el.textContent === proseFromAst(ast)` — the single coordinate system
 * every prose-based operation rides. The label is re-resolved at build time
 * through `resolveClassName`; without a resolver a chip contributes only its
 * displayText (usually "" — the chip is prose-invisible, the pre-chip
 * behavior every non-editor consumer keeps).
 *
 * Mentions DO carry captured text, but it can go stale (import-era captures
 * baked nested-link UUIDs into it). The block editor therefore threads
 * `resolveMentionName` and renders the pill — prose included — from the
 * label-precedence chain `mentionProse` builds: the one-off `displayText`,
 * else the target's CURRENT full title, else the captured text, else the raw
 * target id (the broken-target fallback, read-mode parity: a mention whose
 * target is gone shows the id, never silent retargeting). Without a resolver
 * a mention contributes its captured text exactly as before — every
 * non-editor consumer keeps the pre-resolver projection.
 */

import type { ContentAst, Mark } from "@notees/protocol";

/**
 * Resolves a class chip's display label (the class node's current display
 * name). Optional everywhere: only the block editor threads it (it has the
 * client), so non-editor callers see chips as prose-invisible.
 */
export type ClassNameResolver = (classId: string) => string;

/**
 * Resolves a mention target's current full title (the UNCAPPED
 * title-is-content derivation — read-mode parity; the capped display name
 * would truncate what read mode renders). Returns null when the target is
 * unknown (broken reference). Optional everywhere: only the block editor
 * threads it.
 */
export type MentionNameResolver = (targetNodeId: string) => string | null;

/** A chip's prose contribution: the one-off wording when set, else the
 *  re-resolved class display name, else "" (unresolved and unlabeled). */
function chipLabel(token: Record<string, unknown>, resolveClassName?: ClassNameResolver): string {
  if (typeof token.displayText === "string") return token.displayText;
  if (typeof token.classId === "string") return resolveClassName?.(token.classId) ?? "";
  return "";
}

/**
 * A mention's prose contribution — the label the edit-mode pill renders,
 * the same chain read mode uses (SCHEMA.md render grammar): the one-off
 * `displayText` when set, else the target's re-resolved CURRENT full title,
 * else the captured text (possibly stale — better a stale capture than a
 * raw id), else the raw target id when a resolver was threaded (a
 * textless mention of a broken target still needs SOME pill text in the
 * editable). Without a resolver the captured text passes through
 * verbatim — the projection every non-editor consumer keeps.
 */
export function mentionProse(token: Record<string, unknown>, resolveMentionName?: MentionNameResolver): string {
  if (typeof token.displayText === "string" && token.displayText.length > 0) return token.displayText;
  if (typeof token.targetNodeId === "string" && token.targetNodeId.length > 0) {
    const resolved = resolveMentionName?.(token.targetNodeId);
    if (typeof resolved === "string" && resolved.length > 0) return resolved;
  }
  if (typeof token.text === "string") return token.text;
  return resolveMentionName !== undefined && typeof token.targetNodeId === "string"
    ? token.targetNodeId
    : "";
}

/** Flatten a token stream to the editable plain-text projection. */
export function proseFromAst(
  ast: readonly unknown[],
  resolveClassName?: ClassNameResolver,
  resolveMentionName?: MentionNameResolver,
): string {
  const parts: string[] = [];
  const walk = (tokens: readonly unknown[]): void => {
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as Record<string, unknown>;
      switch (t.type) {
        case "text":
        case "typed_link":
          if (typeof t.text === "string") parts.push(t.text);
          break;
        case "mention":
          parts.push(mentionProse(t, resolveMentionName));
          break;
        case "class_link":
          parts.push(chipLabel(t, resolveClassName));
          break;
        case "math":
          if (typeof t.expression === "string") parts.push(t.expression);
          break;
        case "hard_break":
          parts.push("\n");
          break;
        case "quote":
        case "heading":
          if (Array.isArray(t.children)) walk(t.children);
          break;
        default:
          // asset_ref / embed_ref / query / whiteboard carry no prose.
          break;
      }
    }
  };
  walk(ast);
  return parts.join("");
}

/**
 * Prose offset range of one top-level token: the slice of the projection
 * `proseFromAst` builds from it. Tokens the projection skips (asset_ref,
 * embed_ref, query, whiteboard, malformed entries) get a zero-length range
 * at the current offset. Length rules mirror `proseFromAst`: text /
 * typed_link count `text.length`, a mention counts its resolved label
 * length (`mentionProse` — displayText, else the re-resolved full title,
 * else the captured text), a class_link counts its resolved
 * label length, math counts `expression.length`, hard_break counts 1 (its
 * "\n"), quote counts its inline children.
 */
export interface ProseSpan {
  /** Index of the token in the top-level stream. */
  tokenIndex: number;
  /** Inclusive prose offset where the token's projection starts. */
  start: number;
  /** Exclusive prose offset where it ends (`start === end` for prose-less tokens). */
  end: number;
}

export function proseSpans(
  ast: readonly unknown[],
  resolveClassName?: ClassNameResolver,
  resolveMentionName?: MentionNameResolver,
): ProseSpan[] {
  const spans: ProseSpan[] = [];
  let offset = 0;
  ast.forEach((token, index) => {
    let length = 0;
    if (typeof token === "object" && token !== null) {
      const t = token as Record<string, unknown>;
      switch (t.type) {
        case "text":
        case "typed_link":
          if (typeof t.text === "string") length = t.text.length;
          break;
        case "mention":
          length = mentionProse(t, resolveMentionName).length;
          break;
        case "class_link":
          length = chipLabel(t, resolveClassName).length;
          break;
        case "math":
          if (typeof t.expression === "string") length = t.expression.length;
          break;
        case "hard_break":
          length = 1;
          break;
        case "quote":
        case "heading": {
          // Keep in sync with proseFromAst's walk over nested children.
          if (Array.isArray(t.children)) {
            for (const child of t.children) {
              if (typeof child !== "object" || child === null) continue;
              const c = child as Record<string, unknown>;
              if (c.type === "hard_break") length += 1;
              else if ((c.type === "text" || c.type === "typed_link") && typeof c.text === "string")
                length += c.text.length;
              else if (c.type === "mention") length += mentionProse(c, resolveMentionName).length;
              else if (c.type === "class_link")
                length += chipLabel(c, resolveClassName).length;
              else if (c.type === "math" && typeof c.expression === "string")
                length += c.expression.length;
            }
          }
          break;
        }
        default:
          break;
      }
    }
    spans.push({ tokenIndex: index, start: offset, end: offset + length });
    offset += length;
  });
  return spans;
}

/**
 * Build the token array to store for an edited draft.
 *
 * Rules (editor slice):
 * - "" stores an empty stream.
 * - A single-line draft on a block that was exactly one text run stays one
 *   text run, preserving that run's marks.
 * - Otherwise each "\n" becomes a `hard_break` token and the non-empty text
 *   segments between breaks become plain text runs (marks cannot be mapped
 *   across a split and are dropped — documented slice limitation).
 */
export function astFromProse(prose: string, previous: readonly unknown[]): ContentAst {
  const text = prose.replace(/\r\n?/g, "\n");
  if (text === "") return [];
  const previousRun =
    previous.length === 1 &&
    typeof previous[0] === "object" &&
    previous[0] !== null &&
    (previous[0] as Record<string, unknown>).type === "text"
      ? (previous[0] as { marks?: unknown })
      : null;
  if (!text.includes("\n")) {
    if (previousRun !== null && Array.isArray(previousRun.marks)) {
      return [{ type: "text", text, marks: previousRun.marks as Mark[] }];
    }
    return [{ type: "text", text }];
  }
  const ast: ContentAst = [];
  const segments = text.split("\n");
  segments.forEach((segment, index) => {
    if (segment !== "") ast.push({ type: "text", text: segment });
    if (index < segments.length - 1) ast.push({ type: "hard_break" });
  });
  return ast;
}
