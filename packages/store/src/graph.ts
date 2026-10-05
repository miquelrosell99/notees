/**
 * graph.ts — the graph-view topology projection (§34.80).
 *
 * One derived, read-only projection over the store:
 *  - the node set is classes + present-as-main nodes ONLY (owner ruling:
 *    blocks never render as graph nodes — they surface solely as edge
 *    evidence);
 *  - every edge endpoint rolls up to the node set via its nearest node-set
 *    ancestor (the backlinksWithRollup containment semantics: a mention
 *    authored on a block lands between the block's page and the target; a
 *    block target rolls up to its containing page);
 *  - structural families: mention / property (from the derived edge index),
 *    parent (main-node parentage), class (membership);
 *  - the semantic family is the content co-occurrence projection: a block (or
 *    page) mentioning k distinct targets is a hyperedge projected pairwise
 *    with weight = shared-context count; the hub guard (> SEMANTIC_HUB_GUARD
 *    distinct targets) contributes nothing — an index-style context would
 *    otherwise spray k² edges. Evidence carries the supporting context ids.
 *  - local scope (anchor + depth) BFS-truncates the final edge set.
 *
 * Sparsification (per-node top-K / min-weight) is a display concern — the
 * projection returns the full weighted set.
 */

import type { Store } from "./store.js";

export type GraphEdgeKind = "mention" | "property" | "parent" | "class" | "semantic" | "temporal";

export interface GraphNode {
  id: string;
  isClass: boolean;
  parentId: string | null;
  classIds: string[];
  color: string | null;
  icon: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  /** Multiplicity (structural: contributing rows; semantic: shared contexts). */
  weight: number;
  /** Semantic edges only: up to SEMANTIC_EVIDENCE_CAP supporting context ids. */
  evidence: string[] | null;
}

export interface GraphTopology {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Local-scope selector: BFS from `anchor` over the final edge set. */
export interface GraphOptions {
  anchor?: string;
  depth?: number;
}

export const SEMANTIC_HUB_GUARD = 10;
export const SEMANTIC_EVIDENCE_CAP = 5;

/** The `day` system class seed id (SYSTEM_CLASS_UUIDS.day — inlined to keep
 *  the store package's dependency surface unchanged). */
const DAY_CLASS_ID = "00000000-0000-0000-0001-000000000005";

interface NodeRow {
  id: string;
  is_class: number;
  parent_id: string | null;
  class_ids: string;
  color: string | null;
  icon: string | null;
}

interface IdRow {
  id: string;
  parent_id: string | null;
}

interface EdgeRow {
  source_id: string;
  target_id: string;
}

interface MembershipRow {
  node_id: string;
  class_id: string;
}

export function graphTopology(store: Store, workspaceId: string, options?: GraphOptions): GraphTopology {
  const db = store.database;

  const nodeRows = db
    .prepare(
      `SELECT id, is_class, parent_id, class_ids, color, icon
       FROM node
       WHERE workspace_id = ? AND is_active = 1 AND (is_class = 1 OR present_as_main = 1)`,
    )
    .all(workspaceId) as unknown as NodeRow[];

  const inSet = new Set(nodeRows.map((row) => row.id));

  // Parent map over ALL active nodes: the rollup walks up through blocks.
  const parentRows = db
    .prepare(`SELECT id, parent_id FROM node WHERE workspace_id = ? AND is_active = 1`)
    .all(workspaceId) as unknown as IdRow[];
  const parentOf = new Map<string, string | null>(parentRows.map((row) => [row.id, row.parent_id]));

  /** Nearest node-set ancestor (blocks roll up; node-set nodes resolve to self). */
  const resolveCache = new Map<string, string | null>();
  const resolveToSet = (id: string): string | null => {
    const cached = resolveCache.get(id);
    if (cached !== undefined) return cached;
    let current: string | null = id;
    const seen = new Set<string>();
    let result: string | null = null;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      if (inSet.has(current)) {
        result = current;
        break;
      }
      current = parentOf.get(current) ?? null;
    }
    for (const visited of seen) resolveCache.set(visited, result);
    return result;
  };

  const nodes: GraphNode[] = nodeRows.map((row) => ({
    id: row.id,
    isClass: row.is_class === 1,
    parentId: row.parent_id,
    classIds: JSON.parse(row.class_ids || "[]") as string[],
    color: row.color,
    icon: row.icon,
  }));

  const edges: GraphEdge[] = [];
  const edgeIndex = new Map<string, GraphEdge>();

  const addEdge = (source: string, target: string, kind: GraphEdgeKind, evidenceId?: string): void => {
    const from = resolveToSet(source);
    const to = resolveToSet(target);
    if (from === null || to === null || from === to) return;
    const key = `${kind}:${from}:${to}`;
    const existing = edgeIndex.get(key);
    if (existing !== undefined) {
      existing.weight += 1;
      if (existing.evidence !== null && evidenceId !== undefined && existing.evidence.length < SEMANTIC_EVIDENCE_CAP && !existing.evidence.includes(evidenceId)) {
        existing.evidence.push(evidenceId);
      }
      return;
    }
    const edge: GraphEdge = {
      source: from,
      target: to,
      kind,
      weight: 1,
      evidence: kind === "semantic" || kind === "temporal" ? (evidenceId !== undefined ? [evidenceId] : []) : null,
    };
    edgeIndex.set(key, edge);
    edges.push(edge);
  };

  // Structural mention + property families (multiplicity rides in weight).
  const typedLinkRows = db
    .prepare(
      `SELECT source_id, target_id, type FROM edge
       WHERE workspace_id = ? AND target_id IS NOT NULL AND type IN ('mention', 'property')`,
    )
    .all(workspaceId) as unknown as (EdgeRow & { type: "mention" | "property" })[];
  for (const row of typedLinkRows) {
    addEdge(row.source_id, row.target_id, row.type);
  }

  // Parent family: main-node parentage within the set.
  for (const row of nodeRows) {
    if (row.parent_id !== null && inSet.has(row.parent_id)) {
      addEdge(row.parent_id, row.id, "parent");
    }
  }

  // Class family: OR-Set membership (present rows only), both ends in the set.
  const membershipRows = db
    .prepare(`SELECT node_id, class_id FROM class_member_set WHERE present = 1`)
    .all() as unknown as MembershipRow[];
  for (const row of membershipRows) {
    if (inSet.has(row.node_id) && inSet.has(row.class_id)) {
      addEdge(row.node_id, row.class_id, "class");
    }
  }

  // Semantic family: co-occurrence — group mention targets by their context.
  const mentionRows = typedLinkRows.filter((row) => row.type === "mention");
  const targetsByContext = new Map<string, Set<string>>();
  for (const row of mentionRows) {
    let set = targetsByContext.get(row.source_id);
    if (set === undefined) {
      set = new Set();
      targetsByContext.set(row.source_id, set);
    }
    set.add(row.target_id);
  }
  for (const [contextId, targets] of targetsByContext) {
    if (targets.size < 2 || targets.size > SEMANTIC_HUB_GUARD) continue;
    const from = resolveToSet(contextId);
    if (from === null) continue;
    const rolled = new Set<string>();
    for (const target of targets) {
      const resolved = resolveToSet(target);
      if (resolved !== null && resolved !== from) rolled.add(resolved);
    }
    const members = [...rolled].sort();
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        addEdge(members[i]!, members[j]!, "semantic", contextId);
      }
    }
  }

  // Temporal family: co-occurrence per DAY — targets mentioned anywhere
  // inside the same day page's subtree link with weight = shared days and
  // the day node ids as evidence (the parked §34.80 Q3 design, now shipped).
  const classIdsById = new Map<string, string[]>(nodes.map((n) => [n.id, n.classIds]));
  const dayAncestorOf = (id: string): string | null => {
    let current: string | null = id;
    const seen = new Set<string>();
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      if (inSet.has(current)) {
        const classIds = classIdsById.get(current);
        if (classIds !== undefined && classIds.includes(DAY_CLASS_ID)) return current;
        return null; // reached the node set without passing a day node
      }
      current = parentOf.get(current) ?? null;
    }
    return null;
  };
  const targetsByDay = new Map<string, Set<string>>();
  for (const [contextId, targets] of targetsByContext) {
    const day = dayAncestorOf(contextId);
    if (day === null) continue;
    let set = targetsByDay.get(day);
    if (set === undefined) {
      set = new Set();
      targetsByDay.set(day, set);
    }
    for (const target of targets) {
      const resolved = resolveToSet(target);
      if (resolved !== null && resolved !== day) set.add(resolved);
    }
  }
  for (const [dayId, targets] of targetsByDay) {
    if (targets.size < 2 || targets.size > SEMANTIC_HUB_GUARD) continue;
    const members = [...targets].sort();
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        addEdge(members[i]!, members[j]!, "temporal", dayId);
      }
    }
  }

  let finalNodes = nodes;
  let finalEdges = edges;
  const anchor = options?.anchor;
  if (anchor !== undefined && inSet.has(anchor)) {
    const depth = options?.depth ?? 2;
    const adjacency = new Map<string, string[]>();
    const link = (a: string, b: string): void => {
      let list = adjacency.get(a);
      if (list === undefined) {
        list = [];
        adjacency.set(a, list);
      }
      list.push(b);
    };
    for (const edge of edges) {
      link(edge.source, edge.target);
      link(edge.target, edge.source);
    }
    const reached = new Set<string>([anchor]);
    let frontier = [anchor];
    for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const neighbor of adjacency.get(id) ?? []) {
          if (!reached.has(neighbor)) {
            reached.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
    finalNodes = nodes.filter((node) => reached.has(node.id));
    finalEdges = edges.filter((edge) => reached.has(edge.source) && reached.has(edge.target));
  }

  return { nodes: finalNodes, edges: finalEdges };
}
