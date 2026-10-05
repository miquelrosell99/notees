/**
 * Mark commands over prose offsets — the pure half of the marks editing
 * slice (the DOM half lives in BlockTextEditor: reading the selection,
 * wiring shortcuts/toolbar).
 *
 * `applyMarkToRange` / `removeMarkFromRange` take a prose-offset range
 * (the same projection `proseFromAst` builds: hard_break counts 1, mentions
 * and typed_links count their captured text length) and split/splice the
 * covered text runs, leaving hard_breaks and rich tokens (mentions, chips,
 * links, quotes) untouched — marks apply to text runs in this slice.
 * Adjacent runs with equal marks merge back, so removing a mark restores
 * the run shape the apply started from. Mark order is canonicalized to the
 * MARKS declaration order so results are deterministic.
 */

import type { ContentAst, ContentToken, Mark } from "@notees/protocol";
import { MARKS } from "@notees/protocol";

import { proseSpans, type ClassNameResolver } from "@/editor/prose.js";

const markRank = (mark: Mark): number => MARKS.indexOf(mark);

function isTextToken(token: unknown): token is { type: "text"; text: string; marks?: unknown } {
  return (
    typeof token === "object" &&
    token !== null &&
    (token as Record<string, unknown>).type === "text" &&
    typeof (token as Record<string, unknown>).text === "string"
  );
}

function marksOf(token: { marks?: unknown }): Mark[] {
  const marks = token.marks;
  return Array.isArray(marks) ? (marks.filter((m) => MARKS.includes(m as Mark)) as Mark[]) : [];
}

/** Build a text run, dropping an empty marks array (schema marks is optional). */
function textRun(text: string, marks: readonly Mark[] | undefined): ContentToken {
  const ordered =
    marks !== undefined && marks.length > 0
      ? [...marks].sort((a, b) => markRank(a) - markRank(b))
      : undefined;
  return ordered !== undefined
    ? { type: "text", text, marks: ordered }
    : { type: "text", text };
}

function sameMarks(a: ContentToken, b: ContentToken): boolean {
  if (a.type !== "text" || b.type !== "text") return false;
  const am = Array.isArray(a.marks) ? a.marks : [];
  const bm = Array.isArray(b.marks) ? b.marks : [];
  return am.length === bm.length && am.every((mark) => bm.includes(mark));
}

function mergeAdjacent(tokens: ContentToken[]): ContentToken[] {
  const out: ContentToken[] = [];
  for (const token of tokens) {
    const last = out[out.length - 1];
    if (last !== undefined && sameMarks(last, token)) {
      const lastMarks = (last as { marks?: unknown }).marks;
      out[out.length - 1] = textRun(
        (last as { text: string }).text + (token as { text: string }).text,
        Array.isArray(lastMarks) ? (lastMarks as Mark[]) : undefined,
      );
    } else {
      out.push(token);
    }
  }
  return out;
}

/** Split covered text runs at the range boundaries and add `mark` to the covered slices. */
export function applyMarkToRange(
  ast: readonly unknown[],
  start: number,
  end: number,
  mark: Mark,
  resolveClassName?: ClassNameResolver,
): ContentAst {
  return mapRange(
    ast,
    start,
    end,
    (text, marks) => textRun(text, marks.includes(mark) ? marks : [...marks, mark]),
    resolveClassName,
  );
}

/** The inverse of applyMarkToRange; covered slices drop `mark`, runs merge back. */
export function removeMarkFromRange(
  ast: readonly unknown[],
  start: number,
  end: number,
  mark: Mark,
  resolveClassName?: ClassNameResolver,
): ContentAst {
  return mapRange(
    ast,
    start,
    end,
    (text, marks) => textRun(text, marks.filter((m) => m !== mark)),
    resolveClassName,
  );
}

function mapRange(
  ast: readonly unknown[],
  start: number,
  end: number,
  cover: (text: string, marks: Mark[]) => ContentToken,
  resolveClassName?: ClassNameResolver,
): ContentAst {
  if (start >= end) return ast as ContentAst;
  const spans = proseSpans(ast, resolveClassName);
  const out: ContentToken[] = [];
  let changed = false;
  ast.forEach((token, index) => {
    const span = spans[index]!;
    if (!isTextToken(token) || span.end <= start || span.start >= end) {
      out.push(token as ContentToken);
      return;
    }
    const from = Math.max(start, span.start) - span.start;
    const to = Math.min(end, span.end) - span.start;
    const before = token.text.slice(0, from);
    const covered = token.text.slice(from, to);
    const after = token.text.slice(to);
    if (before !== "") out.push({ ...token, text: before } as ContentToken);
    out.push(cover(covered, marksOf(token)));
    if (after !== "") out.push({ ...token, text: after } as ContentToken);
    changed = true;
  });
  if (!changed) return ast as ContentAst;
  return mergeAdjacent(out);
}

/**
 * Marks shared by EVERY text run the range covers (empty range ⇒ empty set).
 * Drives the toolbar/shortcut toggle: all-covered ⇒ remove, otherwise apply;
 * also the buttons' active state.
 */
export function marksOnRange(
  ast: readonly unknown[],
  start: number,
  end: number,
  resolveClassName?: ClassNameResolver,
): Set<Mark> {
  const shared = new Set<Mark>(MARKS);
  if (start >= end) {
    shared.clear();
    return shared;
  }
  const spans = proseSpans(ast, resolveClassName);
  let coveredAny = false;
  ast.forEach((token, index) => {
    const span = spans[index]!;
    if (!isTextToken(token) || span.end <= start || span.start >= end) return;
    coveredAny = true;
    for (const mark of shared) {
      if (!marksOf(token).includes(mark)) shared.delete(mark);
    }
  });
  if (!coveredAny) shared.clear();
  return shared;
}
