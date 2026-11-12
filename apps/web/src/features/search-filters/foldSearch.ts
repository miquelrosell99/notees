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
