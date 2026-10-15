/**
 * Excerpt derivation — the condensed layer's (stretchtext) one-line
 * projection of a block's content. Domain-pure: no IO, no storage.
 *
 * `excerptOf` flattens a token stream with the EXACT token rules of the
 * prose projection (`proseFromAst`, apps/web — text / typed_link / mention
 * count their `text`, a class_link counts its resolved label, math counts
 * its expression, quote/heading recurse, hard_break and asset_ref /
 * embed_ref / query / whiteboard boundaries carry their own rules) and cuts
 * the flattened prose at the FIRST hard_break OR the dense-chrome budget
 * (DISPLAY_NAME_MAX), whichever comes first. One coordinate system: the
 * returned `cutOffset` is an offset in the same raw concatenation
 * `proseSpans` reports spans over, so callers can classify every token as
 * visible (span start before the cut) or hidden (start at/after it) without
 * a second flatten grammar.
 *
 * Unlike `plainTextExcerpt` (display-name derivation — space-joined,
 * whitespace-normalized), the excerpt keeps the raw concatenation: the
 * excerpt IS the head of the block's own prose (the editor's textContent),
 * never a re-worded summary.
 */

import type { ContentAst, ContentToken } from "@notees/protocol";

import { DISPLAY_NAME_MAX } from "./node.js";

/** The condensed projection of one block's content. */
export interface Excerpt {
  /** Flattened prose, cut at the first hard_break or the budget. */
  text: string;
  /** False → the block fits one line; render the full row, no toggle. */
  truncated: boolean;
  /**
   * Prose offset of the cut (0 when !truncated). A hard_break cut reports
   * the break's offset; a budget cut reports DISPLAY_NAME_MAX. Token spans
   * starting at or after this offset are hidden inside the condensed row.
   */
  cutOffset: number;
}

/** A class chip's prose contribution (mirrors the prose projection rule):
 *  the one-off wording when set, else the re-resolved class display name,
 *  else "" (unresolved and unlabeled — prose-invisible). */
function chipLabel(token: { displayText?: string | undefined; classId?: string | undefined }, resolveClassName?: (classId: string) => string | null): string {
  if (typeof token.displayText === "string") return token.displayText;
  if (typeof token.classId === "string") return resolveClassName?.(token.classId) ?? "";
  return "";
}

/**
 * Flatten `ast` to its excerpt. `resolveClassName` includes class chips'
 * resolved labels (optional — the pure default treats an unresolved chip as
 * prose-invisible, the prose-projection precedent).
 */
export function excerptOf(
  ast: ContentAst | null | undefined,
  resolveClassName?: (classId: string) => string | null,
): Excerpt {
  if (!ast) return { text: "", truncated: false, cutOffset: 0 };
  let prose = "";
  let truncated = false;
  let cutOffset = 0;
  /** Walk returns true once the cut is decided (walk stops there). */
  const walk = (tokens: readonly ContentToken[]): boolean => {
    for (const token of tokens) {
      switch (token.type) {
        case "text":
        case "typed_link":
        case "mention":
          prose += token.text;
          break;
        case "class_link":
          prose += chipLabel(token, resolveClassName);
          break;
        case "math":
          prose += token.expression;
          break;
        case "quote":
        case "heading":
          if (walk(token.children)) return true;
          break;
        case "hard_break":
          // The line cut: everything before the break is the excerpt.
          truncated = true;
          cutOffset = prose.length;
          return true;
        default:
          // asset_ref / embed_ref / query / whiteboard carry no prose.
          break;
      }
      if (prose.length > DISPLAY_NAME_MAX) {
        truncated = true;
        cutOffset = DISPLAY_NAME_MAX;
        prose = prose.slice(0, DISPLAY_NAME_MAX);
        return true;
      }
    }
    return false;
  };
  walk(ast);
  return { text: prose, truncated, cutOffset };
}
