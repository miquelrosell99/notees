/**
 * Capture-slice helpers — typed_link candidateSpans (record-don't-resolve).
 *
 * SCHEMA.md says candidateSpans is an "ordered nearest-first token id list",
 * but the flat content grammar has no token ids (the protocol amendment on
 * the typed_link row, decided 2026-09-26). The pragmatic interpretation,
 * computed on every block save: each typed_link mark's candidateSpans is the
 * list of targetNodeIds of the MENTION tokens in the same block, ordered by
 * prose distance from the mark's start to the mention's start, deduped,
 * capped at 8. Top-level stream only — mentions nested inside quote children
 * are out of scope for the M1 capture slice.
 */

import { proseSpans } from "@/editor/prose.js";

const CANDIDATE_SPANS_CAP = 8;

/**
 * candidateSpans for every typed_link in the stream, as targetNodeId lists
 * (nearest-first by prose distance, deduped, cap 8). Returns a map from
 * token index to list; empty when there is nothing to record.
 * NOTE: distances ride the RESOLVER-FREE projection (chips invisible) — this
 * metadata is stored on every writer's save (editor, CLI, server), so the
 * computation basis must stay writer-agnostic; only the editor's interactive
 * offset math resolves chip labels.
 */
export function computeCandidateSpans(ast: readonly unknown[]): Map<number, string[]> {
  const result = new Map<number, string[]>();
  const spans = proseSpans(ast);
  const mentionSpans: { index: number; start: number; target: string }[] = [];
  ast.forEach((token, index) => {
    if (typeof token !== "object" || token === null) return;
    const t = token as Record<string, unknown>;
    if (t.type === "mention" && typeof t.targetNodeId === "string") {
      mentionSpans.push({ index, start: spans[index]!.start, target: t.targetNodeId });
    }
  });
  if (mentionSpans.length === 0) return result;
  ast.forEach((token, index) => {
    if (typeof token !== "object" || token === null) return;
    const t = token as Record<string, unknown>;
    if (t.type !== "typed_link") return;
    const markStart = spans[index]!.start;
    const nearest = [...mentionSpans]
      .sort((a, b) => Math.abs(a.start - markStart) - Math.abs(b.start - markStart) || a.start - b.start)
      .map((mention) => mention.target)
      .filter((target, position, list) => list.indexOf(target) === position)
      .slice(0, CANDIDATE_SPANS_CAP);
    result.set(index, nearest);
  });
  return result;
}

/**
 * Return the stream with every typed_link's metadata.candidateSpans set to
 * the computed list. Non-mutating; returns the input reference when nothing
 * changes (no typed_links, or spans already current).
 */
export function withCandidateSpans<T extends readonly unknown[]>(ast: T): T {
  const computed = computeCandidateSpans(ast);
  const hasTypedLinks = ast.some(
    (token) =>
      typeof token === "object" &&
      token !== null &&
      (token as Record<string, unknown>).type === "typed_link",
  );
  // No typed_links at all: nothing to record.
  if (!hasTypedLinks) return ast;
  // Explicit empty list when the block has no mentions: "computed, none" —
  // record-don't-resolve means the field is always present on typed_links.
  if (computed.size === 0) {
    let changedEmpty = false;
    const emptied = ast.map((token) => {
      if (typeof token !== "object" || token === null) return token;
      const t = token as Record<string, unknown>;
      if (t.type !== "typed_link") return token;
      const metadata = (typeof t.metadata === "object" && t.metadata !== null
        ? t.metadata
        : {}) as Record<string, unknown>;
      if (Array.isArray(metadata.candidateSpans) && metadata.candidateSpans.length === 0) {
        return token;
      }
      changedEmpty = true;
      return { ...t, metadata: { ...metadata, candidateSpans: [] } };
    });
    return (changedEmpty ? emptied : ast) as T;
  }
  let changed = false;
  const next = ast.map((token, index) => {
    const spans = computed.get(index);
    if (spans === undefined) return token;
    const t = token as Record<string, unknown>;
    const metadata = (typeof t.metadata === "object" && t.metadata !== null ? t.metadata : {}) as Record<string, unknown>;
    const current = Array.isArray(metadata.candidateSpans) ? metadata.candidateSpans : null;
    if (current !== null && current.length === spans.length && current.every((id, i) => id === spans[i])) {
      return token;
    }
    changed = true;
    return { ...t, metadata: { ...metadata, candidateSpans: spans } };
  });
  return (changed ? next : ast) as T;
}
