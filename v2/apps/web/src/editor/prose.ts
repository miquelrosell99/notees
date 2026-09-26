/**
 * prose ⇄ contentAst — the plain-text editing projection of a block's token
 * stream (SCHEMA.md "Content grammar").
 *
 * The M1 editor edits BLOCK PROSE as plain text: the concatenation of the
 * `text` values of text / typed_link / mention tokens, with `hard_break`
 * projected to "\n" (its shift+Enter line jump) so the round trip is lossless
 * for plain blocks. Marks and non-prose tokens are read-only chrome in this
 * slice: editing a block whose contentAst contains tokens the prose
 * projection cannot represent flattens them on save — the caller guards by
 * skipping saves whose draft equals the current prose (BlockTextEditor.flush),
 * so merely touching a mention/chip block without changing its text is free.
 */

import type { ContentAst, Mark } from "@notees/protocol";

/** Flatten a token stream to the editable plain-text projection. */
export function proseFromAst(ast: readonly unknown[]): string {
  const parts: string[] = [];
  const walk = (tokens: readonly unknown[]): void => {
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as Record<string, unknown>;
      switch (t.type) {
        case "text":
        case "typed_link":
        case "mention":
          if (typeof t.text === "string") parts.push(t.text);
          break;
        case "math":
          if (typeof t.expression === "string") parts.push(t.expression);
          break;
        case "hard_break":
          parts.push("\n");
          break;
        case "quote":
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
