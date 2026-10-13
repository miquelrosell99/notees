/**
 * findInPage — the in-page find core (Capacities parity: Cmd/Ctrl+F over the
 * OPEN page, Capacities' find bar).
 *
 * The search runs over the DATA, not the DOM: the subtree is walked
 * depth-first through the workspace client (node + recursive getChildren),
 * so collapsed/hidden blocks are found exactly like rendered ones. Per block
 * the searchable text is the domain's plainTextExcerpt projection (text
 * runs, typed links, mention captured text, class-chip labels, math, quotes
 * and headings recursed; structural tokens carry no prose).
 *
 * v1 documented scope:
 *  - Replace applies ONLY to a match lying fully inside ONE top-level `text`
 *    token of the block's contentAst. A match spanning tokens (a composed
 *    separator between two tokens, or a mention/typed-link/chip boundary) is
 *    navigable but not replaceable — it is skipped with a console-free
 *    no-op. Matches inside quote/heading NESTED tokens are likewise
 *    navigable-only (their provenance is not addressable at the top level).
 *  - No CSS Custom Highlight API painting of all matches (cross-browser
 *    churn): navigation flashes the current match's block row only.
 *
 * The block-text builder re-implements plainTextExcerpt's composition
 * (parts joined by single spaces, whitespace runs collapsed, edges trimmed)
 * while recording per-character provenance back to the raw token text, so a
 * match range can be mapped to an exact [token, start, end) replace plan.
 * Unit tests assert the composed text equals plainTextExcerpt's output.
 */

import type { ContentAst, ContentToken } from "@notees/protocol";

/** The minimal client surface the walk needs (WorkspaceClient and the
 *  WorkerClient proxy both satisfy it structurally). */
export interface FindInPageSource {
  getNode(id: string): { contentAst: ContentAst } | undefined;
  getChildren(id: string): { id: string; contentAst: ContentAst }[];
}

/** Where one composed character came from: a raw token character, or null
 *  for a composed separator space (not replaceable — it spans tokens). */
export interface FindInPageCharProvenance {
  /** Index into the block's TOP-LEVEL contentAst (-1 = a quote/heading
   *  nested token: navigable-only in the v1 replace scope). */
  tokenIndex: number;
  /** Offset of this character inside the token's raw text. */
  rawOffset: number;
}

/** One searchable block: its id, the collapsed plaintext, the per-character
 *  provenance of that text (same length), and the contentAst snapshot the
 *  text was composed from (replace plans are resolved against THIS — the
 *  match offsets and the ast are one snapshot by construction). */
export interface FindInPageBlock {
  blockId: string;
  text: string;
  provenance: readonly (FindInPageCharProvenance | null)[];
  ast: ContentAst;
}

/** One match: a [start, end) range in the BLOCK's composed text (not the
 *  raw token text — map through planReplace before writing). */
export interface FindInPageMatch {
  blockId: string;
  start: number;
  end: number;
  /** False = the match spans tokens or sits in a non-text/nested token:
   *  navigable, but the v1 replace skips it (console-free no-op). */
  replaceable: boolean;
}

export interface FindInPageOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

/** The token types that contribute prose, in plainTextExcerpt's order and
 *  inclusion (a bare class chip without displayText excerpts to nothing —
 *  the pure helper's no-resolver default). */
function pushPart(
  parts: { text: string; tokenIndex: number }[],
  text: string,
  tokenIndex: number,
): void {
  if (text === "") return;
  parts.push({ text, tokenIndex });
}

function collectParts(tokens: readonly ContentToken[], depth: number, parts: { text: string; tokenIndex: number }[]): void {
  tokens.forEach((token, index) => {
    // Only TOP-LEVEL tokens are replace-addressable; nested quote/heading
    // children carry tokenIndex -1 (navigable-only, see the v1 scope).
    const tokenIndex = depth === 0 ? index : -1;
    switch (token.type) {
      case "text":
      case "typed_link":
        pushPart(parts, token.text, tokenIndex);
        break;
      case "mention":
        pushPart(parts, token.displayText ?? token.text, tokenIndex);
        break;
      case "class_chip":
        pushPart(parts, token.displayText ?? "", tokenIndex);
        break;
      case "math":
        pushPart(parts, token.expression, tokenIndex);
        break;
      case "quote":
      case "heading":
        collectParts(token.children, depth + 1, parts);
        break;
      case "hard_break":
        pushPart(parts, " ", tokenIndex);
        break;
      default:
        break;
    }
  });
}

/**
 * Compose the block's searchable text EXACTLY the way plainTextExcerpt does
 * (parts joined by single spaces, whitespace runs collapsed to one space,
 * edges trimmed) while recording per-character provenance back to the raw
 * token text.
 */
export function buildFindInPageBlock(blockId: string, ast: ContentAst): FindInPageBlock {
  const parts: { text: string; tokenIndex: number }[] = [];
  collectParts(ast, 0, parts);

  let text = "";
  const provenance: (FindInPageCharProvenance | null)[] = [];
  let pendingSpace = false;
  let firstPart = true;
  for (const part of parts) {
    if (!firstPart) {
      // The inter-part separator of plainTextExcerpt's parts.join(" ").
      pendingSpace = true;
    }
    firstPart = false;
    for (let i = 0; i < part.text.length; i += 1) {
      const ch = part.text[i]!;
      if (/\s/.test(ch)) {
        pendingSpace = true;
        continue;
      }
      if (pendingSpace && provenance.length > 0) {
        text += " ";
        provenance.push(null);
      }
      pendingSpace = false;
      text += ch;
      provenance.push(
        part.tokenIndex >= 0 ? { tokenIndex: part.tokenIndex, rawOffset: i } : null,
      );
    }
  }
  return { blockId, text, provenance, ast };
}

/**
 * Walk the open node's subtree data-depth-first (node first, then recursive
 * getChildren in order) collecting searchable blocks. A cycle guard bounds
 * the walk the way the store's depth cap does — malformed parentage can
 * never hang the find bar.
 */
export function collectSubtreeBlocks(source: FindInPageSource, rootId: string): FindInPageBlock[] {
  const blocks: FindInPageBlock[] = [];
  const seen = new Set<string>();
  const walk = (id: string, includeSelf: boolean): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = source.getNode(id);
    if (node === undefined) return;
    if (includeSelf) {
      const block = buildFindInPageBlock(id, node.contentAst);
      if (block.text !== "") blocks.push(block);
    }
    for (const child of source.getChildren(id)) {
      walk(child.id, true);
    }
  };
  walk(rootId, true);
  return blocks;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Whole-word: the match is bounded by a non-letter/digit or the string
 *  edge on BOTH sides (the v1 spec's boundary rule). */
function isWholeWord(text: string, start: number, end: number): boolean {
  const leftOk = start === 0 || !WORD_CHAR.test(text[start - 1]!);
  const rightOk = end >= text.length || !WORD_CHAR.test(text[end]!);
  return leftOk && rightOk;
}

/** The v1 replace rule: every character of the match must come from the
 *  SAME top-level token, and that token must be a plain `text` token.
 *  Returns the shared provenance (the raw-span anchor) or null. */
function replaceableAnchor(
  block: FindInPageBlock,
  start: number,
  end: number,
  tokenType: (tokenIndex: number) => ContentToken | undefined,
): FindInPageCharProvenance | null {
  const first = block.provenance[start];
  if (first === undefined || first === null || first.tokenIndex < 0) return null;
  const token = tokenType(first.tokenIndex);
  if (token === undefined || token.type !== "text") return null;
  for (let i = start; i < end; i += 1) {
    const p = block.provenance[i];
    if (p === undefined || p === null || p.tokenIndex !== first.tokenIndex) return null;
  }
  return first;
}

/**
 * Find all matches of the query across the blocks, in document order
 * (the DFS block order, ascending offsets within a block).
 */
export function findMatchesInBlocks(
  blocks: readonly FindInPageBlock[],
  query: string,
  options: FindInPageOptions = {},
): FindInPageMatch[] {
  if (query === "") return [];
  const { caseSensitive = false, wholeWord = false } = options;
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: FindInPageMatch[] = [];
  for (const block of blocks) {
    const haystack = caseSensitive ? block.text : block.text.toLowerCase();
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      const end = idx + needle.length;
      if (!wholeWord || isWholeWord(block.text, idx, end)) {
        matches.push({
          blockId: block.blockId,
          start: idx,
          end,
          replaceable:
            end > idx && replaceableAnchor(block, idx, end, (i) => block.ast[i]) !== null,
        });
      }
      idx = haystack.indexOf(needle, idx + 1);
    }
  }
  return matches;
}

/**
 * Resolve a match to a concrete replace plan against its block's snapshot
 * ast, or null when the v1 scope excludes it (cross-token, non-text, or
 * nested-token match — the caller skips those with a console-free no-op).
 */
export function planReplace(
  block: FindInPageBlock,
  match: { start: number; end: number },
): { tokenIndex: number; start: number; end: number } | null {
  if (match.end <= match.start) return null;
  const first = replaceableAnchor(block, match.start, match.end, (i) => block.ast[i]);
  if (first === null) return null;
  const last = block.provenance[match.end - 1];
  if (last === undefined || last === null) return null;
  return { tokenIndex: first.tokenIndex, start: first.rawOffset, end: last.rawOffset + 1 };
}

/**
 * Apply a plan to a contentAst: the matched span inside the single text
 * token is swapped for the replacement, everything else identical (marks
 * and token identity preserved — the token object is shallow-copied).
 */
export function applyReplace(
  ast: ContentAst,
  plan: { tokenIndex: number; start: number; end: number },
  replacement: string,
): ContentAst {
  return ast.map((token, index) => {
    if (index !== plan.tokenIndex || token.type !== "text") return token;
    return { ...token, text: token.text.slice(0, plan.start) + replacement + token.text.slice(plan.end) };
  });
}
