/**
 * Block-level find/replace helpers for the outliner editor architecture.
 *
 * Operates across the block tree's plain-text projection (one document per
 * block: id + prose) rather than a single monolithic editor instance — the
 * archived widget searched across per-block editor handles; this app projects
 * each block's token stream to prose (editor/prose.ts) and searches that.
 */

import type { ContentAst } from "@notees/protocol";

import { spliceTokens } from "@/editor/edit-apply.js";
import { withCandidateSpans } from "@/editor/capture.js";

/** One searchable block: its id and the prose projection of its token stream. */
export interface BlockSearchDocument {
  id: string;
  prose: string;
}

export interface BlockMatch {
  blockId: string;
  offset: number;
  length: number;
  text: string;
}

/** Execute a search across all block documents. */
export function executeBlockSearch(
  blocks: readonly BlockSearchDocument[],
  query: string,
  caseSensitive: boolean,
): BlockMatch[] {
  if (!query) return [];

  const matches: BlockMatch[] = [];
  for (const block of blocks) {
    const text = block.prose;
    const searchText = caseSensitive ? text : text.toLowerCase();
    const searchQuery = caseSensitive ? query : query.toLowerCase();
    let idx = searchText.indexOf(searchQuery);
    while (idx !== -1) {
      matches.push({
        blockId: block.id,
        offset: idx,
        length: query.length,
        text: text.slice(idx, idx + query.length),
      });
      idx = searchText.indexOf(searchQuery, idx + 1);
    }
  }
  return matches;
}

/** Split replacement text into text / hard_break runs (draft "\n" ⇄ hard_break). */
function replacementRuns(text: string): Record<string, unknown>[] {
  const runs: Record<string, unknown>[] = [];
  text.split("\n").forEach((segment, index, segments) => {
    if (segment !== "") runs.push({ type: "text", text: segment });
    if (index < segments.length - 1) runs.push({ type: "hard_break" });
  });
  return runs;
}

/**
 * Replace the prose range [start, end) of a block's token stream with plain
 * replacement runs. Tokens outside the range keep their marks and identity
 * (the spliceTokens contract); every typed_link mark gets fresh
 * candidateSpans (record-don't-resolve), mirroring the editor's save path.
 */
export function replaceRangeInAst(
  ast: readonly unknown[],
  start: number,
  end: number,
  replacement: string,
): ContentAst {
  return withCandidateSpans(spliceTokens(ast, start, end, replacementRuns(replacement)));
}
