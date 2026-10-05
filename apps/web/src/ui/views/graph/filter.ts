/**
 * graph/filter.ts — the pure display shaping for the graph view (§34.80):
 * settings filtering (node families, link families), collection scoping,
 * and the semantic co-occurrence sparsification (per-node top-K by weight +
 * min-weight threshold, symmetric keep). Pure functions over GraphTopology —
 * unit-tested without a canvas.
 */

import type { GraphEdge, GraphEdgeKind, GraphTopology } from "@notees/store";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

export interface GraphSettings {
  /** Class nodes render (default on). */
  showClasses: boolean;
  /** The journal chain (year/month/day) renders (default OFF — v1 precedent). */
  showJournal: boolean;
  /** Per link-family visibility. */
  families: Record<GraphEdgeKind, boolean>;
  /** Semantic co-occurrence: per-node top-K kept edges (slider). */
  semanticTopK: number;
  /** Semantic co-occurrence: minimum shared-context weight (slider). */
  semanticMinWeight: number;
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  showClasses: true,
  showJournal: false,
  families: { mention: true, property: true, parent: true, class: true, semantic: true },
  semanticTopK: 6,
  semanticMinWeight: 1,
};

const JOURNAL_CLASS_IDS = new Set<string>([
  SYSTEM_CLASS_UUIDS.year,
  SYSTEM_CLASS_UUIDS.month,
  SYSTEM_CLASS_UUIDS.day,
]);

/** True when the node belongs to the journal chain. */
export function isJournalNode(node: { id: string; classIds: string[] }): boolean {
  return node.classIds.some((id) => JOURNAL_CLASS_IDS.has(id));
}

/**
 * The semantic sparsification: per-node top-K by weight, min-weight cut,
 * symmetric keep (an edge survives when EITHER endpoint keeps it). The cut
 * is display-only — the projection stays whole.
 */
export function sparsifySemantic(edges: GraphEdge[], topK: number, minWeight: number): GraphEdge[] {
  const semantic = edges.filter((e) => e.kind === "semantic" && e.weight >= minWeight);
  if (semantic.length === 0) return [];
  const byNode = new Map<string, GraphEdge[]>();
  const link = (id: string, edge: GraphEdge): void => {
    let list = byNode.get(id);
    if (list === undefined) {
      list = [];
      byNode.set(id, list);
    }
    list.push(edge);
  };
  for (const edge of semantic) {
    link(edge.source, edge);
    link(edge.target, edge);
  }
  const kept = new Set<GraphEdge>();
  for (const list of byNode.values()) {
    list.sort((a, b) => b.weight - a.weight);
    for (const edge of list.slice(0, Math.max(1, topK))) kept.add(edge);
  }
  return [...kept];
}

/**
 * Apply the settings to a topology: node-family filters, link-family filters,
 * semantic sparsification, and (optionally) scoping to a collection's items.
 * Returns the display topology — the input is never mutated.
 */
export function applyGraphSettings(
  topology: GraphTopology,
  settings: GraphSettings,
  scope?: ReadonlySet<string>,
): GraphTopology {
  const nodes = topology.nodes.filter((node) => {
    if (scope !== undefined && !scope.has(node.id)) return false;
    if (node.isClass && !settings.showClasses) return false;
    if (!settings.showJournal && isJournalNode(node)) return false;
    return true;
  });
  const nodeIds = new Set(nodes.map((n) => n.id));

  const structural = topology.edges.filter(
    (e) => e.kind !== "semantic" && settings.families[e.kind] === true,
  );
  const semantic = settings.families.semantic === true
    ? sparsifySemantic(topology.edges, settings.semanticTopK, settings.semanticMinWeight)
    : [];

  const edges = [...structural, ...semantic].filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );
  return { nodes, edges };
}

/** Honest counts for the toolbar (the §34.70 rule: counts name the full set). */
export function graphCounts(topology: GraphTopology): { nodes: number; edges: number } {
  return { nodes: topology.nodes.length, edges: topology.edges.length };
}

/** Renderer link-type ids (shader edge mask bits) for the v2 families. */
export const LINK_TYPE_IDS: Record<GraphEdgeKind, number> = {
  parent: 0,
  class: 1,
  mention: 2,
  property: 3,
  semantic: 4,
};

/**
 * The zoom-dependent edge LOD mask (the v1 convention): parent/class always,
 * mention from 0.30, property from 0.60, semantic from 1.00.
 */
export function edgeMaskForZoom(zoom: number): number {
  let mask = (1 << LINK_TYPE_IDS.parent) | (1 << LINK_TYPE_IDS.class);
  if (zoom >= 0.3) mask |= 1 << LINK_TYPE_IDS.mention;
  if (zoom >= 0.6) mask |= 1 << LINK_TYPE_IDS.property;
  if (zoom >= 1.0) mask |= 1 << LINK_TYPE_IDS.semantic;
  return mask;
}
