/**
 * Node-scoped hosted views (custom tabs — the prefs channel).
 *
 * Same ruling as favorites/recents: custom views on collection-backed
 * surfaces are cross-device UI state, so they live in the sync server's
 * prefs store, never the op log — but they belong to the NODE, not to a
 * user: every user of the deployment shares a node's tabs (applied to system sections too). The client speaks REST (the
 * five endpoints under /api/nodes/:nodeId/sections/:sectionKey/views, the
 * empty section key traveling as the "-" sentinel); the sectionViews module
 * (features/collection/sectionViews.ts) owns syncing, the device-local
 * cache, and the React hook. queryAst is the verbatim QueryAST v1 the
 * FilterBuilderModal produced — parsed again at resolution time. There is
 * deliberately no viewMode: view modes are transient surface state, not
 * stored. This module holds the wire types and the response normalizers.
 */

/** The collection-backed sections that may host custom views (the server's vocabulary). */
export type HostedSectionKey = "linked-references" | "unlinked-mentions" | "classed-nodes";

export const HOSTED_SECTION_KEYS: readonly HostedSectionKey[] = [
  "linked-references",
  "unlinked-mentions",
  "classed-nodes",
];

/** One custom view row (the server node_view table, wire shape). */
export interface SectionView {
  id: string;
  nodeId: string;
  sectionKey: string;
  name: string;
  sequence: number;
  queryAst: unknown;
  createdAt: number;
  updatedAt: number;
}

/** Server body → SectionView; a malformed row is a loud error, never half-read. */
export function normalizeSectionView(raw: unknown): SectionView {
  const value = raw as Partial<SectionView>;
  if (
    typeof value !== "object" || value === null ||
    typeof value.id !== "string" ||
    typeof value.nodeId !== "string" ||
    typeof value.sectionKey !== "string" ||
    typeof value.name !== "string" ||
    typeof value.sequence !== "number" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    throw new Error("section view response missing id/nodeId/sectionKey/name/sequence/timestamps");
  }
  return {
    id: value.id,
    nodeId: value.nodeId,
    sectionKey: value.sectionKey,
    name: value.name,
    sequence: value.sequence,
    queryAst: value.queryAst ?? null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function normalizeSectionViewList(body: unknown): SectionView[] {
  const value = body as { views?: unknown };
  if (typeof value !== "object" || value === null || !Array.isArray(value.views)) {
    throw new Error("section view list response missing views array");
  }
  return value.views.map(normalizeSectionView);
}
