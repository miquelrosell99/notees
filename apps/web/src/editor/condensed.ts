/**
 * hiddenLinksOf — the condensed layer's honest link count (owner idea,
 * 2026-10-15): a hidden link is a MENTION token whose prose span starts at
 * or after the excerpt's cutOffset, computed from the same `proseSpans`
 * projection the editor rides — one coordinate system, no second grammar.
 * A mention straddling the cut starts before it, so it counts as visible.
 * Typed-link marks are excluded (targetless today — the badge must never
 * imply a link the graph can't resolve) and class chips are render-only by
 * decree — the badge names exactly one thing: "this condensed block
 * mentions N nodes you can't see."
 */

import { proseSpans, type ClassNameResolver } from "./prose.js";

export interface HiddenLinkTarget {
  /** The mention token's target node id. */
  targetNodeId: string;
  /** The token's prose span start (always >= the excerpt's cutOffset). */
  start: number;
}

/**
 * The mention targets hidden inside a condensed row. `cutOffset` is the
 * excerpt's cut (`excerptOf(...).cutOffset`); callers only ask while the
 * excerpt is truncated. `resolveClassName` keeps the spans aligned with the
 * excerpt derivation (chips count their resolved label in both).
 */
export function hiddenLinksOf(
  ast: readonly unknown[],
  cutOffset: number,
  resolveClassName?: ClassNameResolver,
): HiddenLinkTarget[] {
  if (cutOffset <= 0) return [];
  const spans = proseSpans(ast, resolveClassName);
  const hidden: HiddenLinkTarget[] = [];
  for (const span of spans) {
    if (span.start < cutOffset) continue;
    const token = ast[span.tokenIndex];
    if (
      typeof token === "object" &&
      token !== null &&
      (token as { type?: unknown }).type === "mention" &&
      typeof (token as { targetNodeId?: unknown }).targetNodeId === "string"
    ) {
      hidden.push({
        targetNodeId: (token as { targetNodeId: string }).targetNodeId,
        start: span.start,
      });
    }
  }
  return hidden;
}
