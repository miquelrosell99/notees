/**
 * Structural edit application — the save-path replacement for
 * `astFromProse`'s flatten-everything behavior (see prose.ts).
 *
 * Given the old token array and the new plain-text draft, the change is
 * applied to the token stream instead of replacing it with a single text
 * run (v1 `setNodeText` pattern): the common prefix/suffix between the old
 * prose and the draft brackets the changed middle, and only the tokens the
 * middle covers are touched —
 *
 * - fully covered runs drop (their marks drop with them),
 * - partially covered text runs get their text spliced (marks kept),
 * - untouched runs keep their marks and object identity,
 * - the replacement text parses into plain text / hard_break runs; the
 *   first run inherits the marks of the text run abutting the splice start
 *   (typing at the end of a bold run stays bold — contentEditable behavior),
 *   the last run inherits the marks abutting the splice end.
 *
 * Rich tokens (mention, typed_link, class_chip, external_link, math, quote)
 * are prose-visible but not structurally editable: a change strictly before
 * or after them leaves them intact (a mention's captured text may go stale
 * when text is inserted next to it — display resolves the target name, so
 * this is acceptable). A change that COVERS a rich token is ambiguous (the
 * diff cannot know if the user meant to edit the mention), so the covered
 * span falls back to the old flatten behavior — plain text / hard_break
 * runs built from the span's prose — while everything outside the span is
 * preserved.
 */

import type { ContentAst, Mark } from "@notees/protocol";

import { proseFromAst, proseSpans } from "@/editor/prose.js";

/** A location in the token stream, from a prose offset. */
interface StreamLoc {
  tokenIndex: number;
  /** Offset inside the located token's prose (0 for boundaries). */
  inner: number;
}

function isTextToken(token: unknown): token is { type: "text"; text: string; marks?: Mark[] } {
  return (
    typeof token === "object" &&
    token !== null &&
    (token as Record<string, unknown>).type === "text" &&
    typeof (token as Record<string, unknown>).text === "string"
  );
}

function isPlainToken(token: unknown): boolean {
  if (typeof token !== "object" || token === null) return true;
  const type = (token as Record<string, unknown>).type;
  return type === "text" || type === "hard_break";
}

function tokenMarks(token: unknown): Mark[] | undefined {
  if (!isTextToken(token)) return undefined;
  const marks = (token as { marks?: unknown }).marks;
  return Array.isArray(marks) ? (marks as Mark[]) : undefined;
}

/** First token whose prose extends past `offset`; end-of-stream if none. */
function locate(spans: ReturnType<typeof proseSpans>, offset: number): StreamLoc {
  for (const span of spans) {
    if (span.end > offset) return { tokenIndex: span.tokenIndex, inner: offset - span.start };
  }
  return { tokenIndex: spans.length, inner: 0 };
}

function textRun(text: string, marks: Mark[] | undefined): Record<string, unknown> {
  return marks !== undefined && marks.length > 0 ? { type: "text", text, marks } : { type: "text", text };
}

/** Split draft text into text / hard_break runs (draft "\n" ⇄ hard_break). */
function parseRuns(text: string): Record<string, unknown>[] {
  const runs: Record<string, unknown>[] = [];
  text.split("\n").forEach((segment, index, segments) => {
    if (segment !== "") runs.push(textRun(segment, undefined));
    if (index < segments.length - 1) runs.push({ type: "hard_break" });
  });
  return runs;
}

function sameMarks(a: Mark[] | undefined, b: Mark[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((mark) => b.includes(mark));
}

/** Merge adjacent text runs carrying the same marks (never mutates inputs). */
function mergeAdjacentTextRuns(tokens: unknown[]): ContentAst {
  const out: unknown[] = [];
  for (const token of tokens) {
    const last = out[out.length - 1];
    if (isTextToken(last) && isTextToken(token) && sameMarks(tokenMarks(last), tokenMarks(token))) {
      out[out.length - 1] = {
        ...last,
        text: (last as { text: string }).text + (token as { text: string }).text,
      };
    } else {
      out.push(token);
    }
  }
  return out as ContentAst;
}

/** Nearest text run whose prose ends exactly at the splice start. */
function precedingMarks(
  previous: readonly unknown[],
  spans: ReturnType<typeof proseSpans>,
  from: StreamLoc,
  start: number,
): Mark[] | undefined {
  if (from.inner > 0) return tokenMarks(previous[from.tokenIndex]);
  for (let i = from.tokenIndex - 1; i >= 0; i -= 1) {
    if (spans[i]!.end === start) return tokenMarks(previous[i]);
  }
  return undefined;
}

/** Nearest text run whose prose starts exactly at the splice end. */
function followingMarks(
  previous: readonly unknown[],
  spans: ReturnType<typeof proseSpans>,
  to: StreamLoc,
  oldEnd: number,
): Mark[] | undefined {
  if (to.inner > 0) return tokenMarks(previous[to.tokenIndex]);
  for (let i = to.tokenIndex; i < previous.length; i += 1) {
    if (spans[i]!.start === oldEnd) return tokenMarks(previous[i]);
  }
  return undefined;
}

/**
 * Apply a plain-text draft to the previous token stream, structurally.
 * `draft` is the contentEditable textContent (CRLF normalized like
 * `astFromProse`). Returns `previous` untouched when the prose is identical.
 */
export function applyTextEdit(previous: readonly unknown[], draft: string): ContentAst {
  const prose = proseFromAst(previous);
  const next = draft.replace(/\r\n?/g, "\n");
  if (next === prose) return previous as ContentAst;

  // v1 setNodeText pattern: bracket the change with a common prefix/suffix.
  let start = 0;
  const minLen = Math.min(prose.length, next.length);
  while (start < minLen && prose.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  let oldEnd = prose.length;
  let newEnd = next.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    prose.charCodeAt(oldEnd - 1) === next.charCodeAt(newEnd - 1)
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const spans = proseSpans(previous);
  const from = locate(spans, start);
  const to = locate(spans, oldEnd);
  const inserted = next.slice(start, newEnd);

  // A change is ambiguous when it touches a prose-visible token the splice
  // cannot edit structurally (mention / typed_link / quote / ...): fall back
  // to flattening the COVERED SPAN only, preserving everything outside it.
  const covered = previous.slice(from.tokenIndex, to.tokenIndex);
  const ambiguous =
    covered.some((token) => !isPlainToken(token)) ||
    (from.inner > 0 && !isTextToken(previous[from.tokenIndex])) ||
    (to.inner > 0 && !isTextToken(previous[to.tokenIndex]));

  const out: unknown[] = previous.slice(0, from.tokenIndex);
  if (ambiguous) {
    // Span prose = old prose of the covered tokens with the change applied;
    // stored back as plain runs (the old flatten behavior, span-local).
    const spanStart = spans[from.tokenIndex] !== undefined ? spans[from.tokenIndex]!.start : prose.length;
    const spanEnd =
      to.tokenIndex < previous.length
        ? to.inner > 0
          ? spans[to.tokenIndex]!.end
          : spans[to.tokenIndex]!.start
        : prose.length;
    const spanProse =
      prose.slice(spanStart, start) + inserted + prose.slice(oldEnd, spanEnd);
    out.push(...parseRuns(spanProse));
  } else {
    if (from.inner > 0) {
      const head = previous[from.tokenIndex] as { text: string };
      out.push({ ...head, text: head.text.slice(0, from.inner) });
    }
    const firstMarks = precedingMarks(previous, spans, from, start);
    const lastMarks = followingMarks(previous, spans, to, oldEnd);
    const runs = parseRuns(inserted);
    if (runs.length > 0) {
      const firstText = runs.findIndex((run) => run.type === "text");
      const lastText = runs.length - 1 - [...runs].reverse().findIndex((run) => run.type === "text");
      runs.forEach((run, index) => {
        if (run.type !== "text") return;
        const inherited =
          index === firstText ? firstMarks : index === lastText ? lastMarks : undefined;
        if (inherited !== undefined && inherited.length > 0) run.marks = [...inherited];
      });
      out.push(...runs);
    }
    if (to.inner > 0) {
      const tail = previous[to.tokenIndex] as { text: string };
      out.push({ ...tail, text: tail.text.slice(to.inner) });
    }
  }
  const tailStart = to.tokenIndex + (to.inner > 0 ? 1 : 0);
  out.push(...previous.slice(tailStart));
  return mergeAdjacentTextRuns(out);
}
