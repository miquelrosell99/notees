/**
 * graph/filter.ts — the pure display shaping for the graph view:
 * settings filtering (node families, link families), collection scoping,
 * and the semantic co-occurrence sparsification (per-node top-K by weight +
 * min-weight threshold, symmetric keep). Pure functions over GraphTopology —
 * unit-tested without a canvas.
 */

import type { GraphEdge, GraphEdgeKind, GraphTopology } from "@notees/store";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

/**
 * The graph node set is classes + standalone pages ONLY (the
 * blocks-never-render law — blocks surface solely as edge evidence). The
 * scope builder walks an item's parent chain to its nearest node-set
 * member; anything else about the node is irrelevant to the walk.
 */
export interface GraphScopeNode {
  id: string;
  isClass: boolean;
  isEmbedded: boolean;
  parentId: string | null;
}

/** The narrow client read the scope builder needs (both client classes fit). */
export interface GraphScopeReader {
  getNode(id: string): GraphScopeNode | undefined;
}

export function isGraphNodeSetMember(node: GraphScopeNode): boolean {
  return node.isClass || !node.isEmbedded;
}

/**
 * Roll a collection's item ids up to the graph node set (the
 * blocks-roll-up-to-pages law at scope time): a block item maps to the page
 * holding it — the walk steps THROUGH embedded parents to the first
 * standalone node (a subpage is its own graph node; a class is always one).
 * A parentless block has no graph node above it and drops from the scope.
 * Returns the rolled-up id set; the display filter then keeps only topology
 * nodes in the set AND edges with BOTH endpoints in it — an edge to a node
 * outside the collection DROPS (no dimmed out-of-scope nodes: the renderer
 * draws the collection's own skeleton, nothing else).
 */
export function rollupGraphScope(
  reader: GraphScopeReader,
  itemIds: readonly string[],
): Set<string> {
  const scope = new Set<string>();
  for (const id of itemIds) {
    const seen = new Set<string>([id]);
    let current = reader.getNode(id);
    while (
      current !== undefined &&
      !isGraphNodeSetMember(current) &&
      current.parentId !== null &&
      !seen.has(current.parentId)
    ) {
      seen.add(current.parentId);
      current = reader.getNode(current.parentId);
    }
    if (current !== undefined && isGraphNodeSetMember(current)) scope.add(current.id);
  }
  return scope;
}

export interface GraphSettings {
  /** Class nodes render (default on). */
  showClasses: boolean;
  /** Journal chain granularity — each level toggles independently. */
  journalYear: boolean;
  journalMonth: boolean;
  journalDay: boolean;
  /** Seeded system pages (the Inbox; the withdrawn scratchpad) render. */
  showSystemPages: boolean;
  /** Orphan nodes (no visible edges) render (default on). */
  showOrphans: boolean;
  /** Per link-family visibility. */
  families: Record<GraphEdgeKind, boolean>;
  /** Semantic co-occurrence: per-node top-K kept edges (slider). */
  semanticTopK: number;
  /** Semantic co-occurrence: minimum shared-context weight (slider). */
  semanticMinWeight: number;
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  showClasses: true,
  journalYear: false,
  journalMonth: false,
  journalDay: false,
  showSystemPages: true,
  showOrphans: true,
  families: {
    mention: true,
    property: true,
    parent: true,
    class: true,
    semantic: true,
    temporal: true,
  },
  semanticTopK: 6,
  semanticMinWeight: 1,
};

const JOURNAL_CLASS_IDS: Record<"year" | "month" | "day", string> = {
  year: SYSTEM_CLASS_UUIDS.year,
  month: SYSTEM_CLASS_UUIDS.month,
  day: SYSTEM_CLASS_UUIDS.day,
};

/** Seeded system pages (the withdrawn scratchpad id lives on in old workspaces). */
const SYSTEM_PAGE_IDS = new Set<string>([
  "00000000-0000-0000-0002-000000000001",
  "00000000-0000-0000-0002-000000000002",
]);

/**
 * True when the settings hide this node: every journal level it belongs to is
 * off, or it is a seeded system page and system pages are off.
 */
export function isNodeHiddenBySettings(
  node: GraphTopology["nodes"][number],
  settings: GraphSettings,
): boolean {
  const journalClasses = node.classIds.filter(
    (id) => id === JOURNAL_CLASS_IDS.year || id === JOURNAL_CLASS_IDS.month || id === JOURNAL_CLASS_IDS.day,
  );
  const hiddenByJournal =
    journalClasses.length > 0 &&
    journalClasses.every((id) => {
      if (id === JOURNAL_CLASS_IDS.year) return !settings.journalYear;
      if (id === JOURNAL_CLASS_IDS.month) return !settings.journalMonth;
      return !settings.journalDay;
    });
  if (hiddenByJournal) return true;
  if (!settings.showSystemPages && SYSTEM_PAGE_IDS.has(node.id)) return true;
  return false;
}

/**
 * The semantic/temporal sparsification: per-node top-K by weight, min-weight
 * cut, symmetric keep (an edge survives when EITHER endpoint keeps it). The
 * cut is display-only — the projection stays whole.
 */
export function sparsifySemantic(
  edges: GraphEdge[],
  topK: number,
  minWeight: number,
  kind: GraphEdgeKind = "semantic",
): GraphEdge[] {
  const semantic = edges.filter((e) => e.kind === kind && e.weight >= minWeight);
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
 * semantic sparsification, the orphan filter, and (optionally) scoping to a
 * collection's items. Scoping keeps only the rolled-up scope's nodes and the
 * edges with BOTH endpoints in scope — an edge to a node outside the
 * collection drops (no out-of-scope rendering). Returns the display
 * topology — the input is never mutated.
 */
export function applyGraphSettings(
  topology: GraphTopology,
  settings: GraphSettings,
  scope?: ReadonlySet<string>,
): GraphTopology {
  const nodes = topology.nodes.filter((node) => {
    if (scope !== undefined && !scope.has(node.id)) return false;
    if (node.isClass && !settings.showClasses) return false;
    return !isNodeHiddenBySettings(node, settings);
  });
  const nodeIds = new Set(nodes.map((n) => n.id));

  const structural = topology.edges.filter(
    (e) => e.kind !== "semantic" && e.kind !== "temporal" && settings.families[e.kind] === true,
  );
  const semantic = settings.families.semantic === true
    ? sparsifySemantic(topology.edges, settings.semanticTopK, settings.semanticMinWeight, "semantic")
    : [];
  const temporal = settings.families.temporal === true
    ? sparsifySemantic(topology.edges, settings.semanticTopK, settings.semanticMinWeight, "temporal")
    : [];

  let edges = [...structural, ...semantic, ...temporal].filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );
  let finalNodes = nodes;
  if (!settings.showOrphans) {
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    finalNodes = nodes.filter((node) => (degree.get(node.id) ?? 0) > 0);
    const kept = new Set(finalNodes.map((n) => n.id));
    edges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));
  }
  return { nodes: finalNodes, edges };
}

/** Honest counts for the toolbar (counts name the full set). */
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
  temporal: 5,
};

/**
 * The zoom-dependent edge LOD mask (the original convention): parent/class always,
 * mention from 0.30, property from 0.60, semantic + temporal from 1.00.
 */
export function edgeMaskForZoom(zoom: number): number {
  let mask = (1 << LINK_TYPE_IDS.parent) | (1 << LINK_TYPE_IDS.class);
  if (zoom >= 0.3) mask |= 1 << LINK_TYPE_IDS.mention;
  if (zoom >= 0.6) mask |= 1 << LINK_TYPE_IDS.property;
  if (zoom >= 1.0) mask |= (1 << LINK_TYPE_IDS.semantic) | (1 << LINK_TYPE_IDS.temporal);
  return mask;
}
