/**
 * foldSearch — the folded (diacritics-insensitive) text-matching helpers
 * behind the pickers, the palette, and the property/class search rows.
 *
 * Every name-matching surface folds BOTH sides the same way: trim +
 * lowercase + `foldSearchText` (the store's folding mirror). The two
 * helpers pin that recipe so a site can't fold one side and not the other.
 */

import { foldSearchText } from "@notees/store";

/** The query side: trimmed, lowercased, folded. Empty string matches nothing specially — callers treat "" as "no filter". */
export function foldedQueryOf(raw: string): string {
  return foldSearchText(raw.trim().toLowerCase());
}

/** The candidate side: `text` lowercased + folded, tested against a folded query. */
export function foldedTextOf(raw: string): string {
  return foldSearchText(raw.toLowerCase());
}

/** True when `text` contains the folded query as a substring. */
export function foldedIncludes(foldedQuery: string, text: string): boolean {
  return foldedTextOf(text).includes(foldedQuery);
}

/**
 * True when `text` starts with the folded query or carries it at a word
 * boundary ("gmi" matches "GMI Dental"; "dental" matches "GMI Dental") —
 * the "partial exact" tier: the typed text IS the beginning of something
 * that exists, so a create row anchors below it rather than hoisting
 * above it.
 */
export function foldedStartsWithOrBoundary(foldedQuery: string, text: string): boolean {
  if (foldedQuery === "") return false;
  const folded = foldedTextOf(text);
  if (folded.startsWith(foldedQuery)) return true;
  const boundary = new RegExp(
    `(^|[^\\p{L}\\p{N}])${foldedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "u",
  );
  return boundary.test(folded);
}
