/**
 * recentUse — the shared "recently used" recency composition behind the
 * command palette's home sections and the node picker's empty-query listing.
 *
 * Two arms, in palette order: recently CREATED (the caller's chrome pool by
 * createdAt, newest first) then recently LINKED (distinct mention/tag edge
 * targets by most recent incoming link, the store's `recentLinkTargets`
 * read), the linked arm dropping any id the created arm already claimed.
 * Role/scope filtering and display caps are the CALLER's: the palette
 * chrome-filters + caps the linked arm at five per section; the picker
 * filters both arms per search mode / scope tabs and pages with its display
 * limit. Merely OPENED pages are not a use anywhere — opening feeds the
 * sidebar's device-local Recents, a different list.
 */

import type { ClientNode } from "@/core/workspace-client/index.js";

/** The client reads the linked arm needs — both full client classes carry them. */
export interface RecentUseSource {
  recentLinkTargets(limit: number): Array<{ id: string; linkedAt: string | null }>;
  getNode(id: string): ClientNode | undefined;
}

export interface RecentUseSections<T> {
  /** Recently created pool rows, newest first — the palette's first home section. */
  created: T[];
  /**
   * Recently linked targets NOT claimed by the created arm, MRU by the most
   * recent incoming link — the palette's second home section, pre-chrome-filter.
   */
  linked: ClientNode[];
}

export function recentUseSections<T extends { id: string; createdAt: string | null }>(
  source: RecentUseSource,
  createdPool: readonly T[],
  limit: number,
): RecentUseSections<T> {
  const created = [...createdPool]
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, limit);
  const claimed = new Set(created.map((row) => row.id));
  const linked = source
    .recentLinkTargets(limit)
    .map((row) => source.getNode(row.id))
    .filter((node): node is ClientNode => node !== undefined)
    .filter((node) => !claimed.has(node.id));
  return { created, linked };
}
