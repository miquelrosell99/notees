/**
 * graph.ts — the graph-view topology projection.
 *
 * One derived, read-only projection over the store:
 *  - the node set is classes + present-as-main nodes ONLY (owner ruling:
 *    blocks never render as graph nodes — they surface solely as edge
 *    evidence); node ALIASES are not vertices either — a node carrying
 *    `aliased_node_id` collapses into its terminal (an edge incident to an
 *    alias renders incident to the terminal; repointed parallels merge into
 *    one weighted edge);
 *  - every edge endpoint rolls up to the node set via its nearest node-set
 *    ancestor (the backlinksWithRollup containment semantics: a mention
 *    authored on a block lands between the block's page and the target; a
 *    block target rolls up to its containing page); the walk steps THROUGH
 *    aliases — an endpoint (or ancestor) that is an alias resolves to the
 *    alias-terminal, never to the alias itself;
 *  - structural families: mention / property (from the derived edge index),
 *    parent (main-node parentage), class (membership);
 *  - the semantic family is the content co-occurrence projection: a block (or
 *    page) mentioning k distinct targets is a hyperedge projected pairwise
 *    with weight = shared-context count; the hub guard (> SEMANTIC_HUB_GUARD
 *    distinct targets) contributes nothing — an index-style context would
 *    otherwise spray k² edges. Evidence carries the supporting context ids.
 *  - local scope (anchor + depth) BFS-truncates the final edge set; the
 *    anchor resolves through the alias-terminal first (an alias anchor shows
 *    its terminal's neighborhood).
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
  /** Descendant blocks of this node (the walk stops at nested main nodes). */
  contentSize: number;
  /** 1 + the recursive descendant weight over ALL active nodes below this
   *  one (through blocks and sub-pages alike) — heavy parents resist the
   *  force layout. Cycle-safe. */
  mass: number;
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

/** Alias-chain cap for the in-memory graph terminal walk (the store walker's
 *  precedent — chains are user-built and tiny; the cap bounds pathological
 *  data). */
const ALIAS_GRAPH_DEPTH_CAP = 32;

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

interface AliasRow {
  id: string;
  aliased_node_id: string | null;
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
       WHERE workspace_id = ? AND is_active = 1 AND (is_class = 1 OR present_as_main = 1)
         AND aliased_node_id IS NULL`,
    )
    .all(workspaceId) as unknown as NodeRow[];

  const inSet = new Set(nodeRows.map((row) => row.id));

  // Children map over ALL active nodes — the content-size and mass walks
  // descend through blocks (a page's metrics include its block tree); mass
  // continues through sub-pages, content size stops at nested main nodes.
  const childRows = db
    .prepare(
      `SELECT id, parent_id, present_as_main, is_class FROM node
       WHERE workspace_id = ? AND is_active = 1 AND parent_id IS NOT NULL`,
    )
    .all(workspaceId) as unknown as Array<{
    id: string;
    parent_id: string;
    present_as_main: number;
    is_class: number;
  }>;
  const childrenOf = new Map<string, string[]>();
  for (const row of childRows) {
    let list = childrenOf.get(row.parent_id);
    if (list === undefined) {
      list = [];
      childrenOf.set(row.parent_id, list);
    }
    list.push(row.id);
  }
  const isMainChild = new Map<string, boolean>(
    childRows.map((row) => [row.id, row.present_as_main === 1 || row.is_class === 1]),
  );

  // One memoized, cycle-safe recursion serves both metrics: mass = 1 + Σ
  // child mass; content size = Σ (1 for plain blocks + nested blocks of
  // non-main children). Mass walks everything below; content size belongs
  // to the page that renders the blocks.
  const metricCache = new Map<string, { mass: number; content: number }>();
  const computing = new Set<string>();
  const metricsOf = (id: string): { mass: number; content: number } => {
    const cached = metricCache.get(id);
    if (cached !== undefined) return cached;
    if (computing.has(id)) return { mass: 1, content: 0 };
    computing.add(id);
    let mass = 1;
    let content = 0;
    for (const childId of childrenOf.get(id) ?? []) {
      const child = metricsOf(childId);
      mass += child.mass;
      // A nested main node renders its own content — it neither counts as a
      // block of the parent nor drags its subtree into the parent's count.
      content += isMainChild.get(childId) === true ? 0 : 1 + child.content;
    }
    computing.delete(id);
    const result = { mass, content };
    metricCache.set(id, result);
    return result;
  };

  // Parent + alias maps over ALL active nodes: the rollup walks up through
  // blocks, and through aliases (an alias is transparent — its terminal is
  // the vertex an edge incident to it renders against).
  const parentRows = db
    .prepare(`SELECT id, parent_id FROM node WHERE workspace_id = ? AND is_active = 1`)
    .all(workspaceId) as unknown as IdRow[];
  const parentOf = new Map<string, string | null>(parentRows.map((row) => [row.id, row.parent_id]));
  const aliasRows = db
    .prepare(`SELECT id, aliased_node_id FROM node WHERE workspace_id = ? AND is_active = 1`)
    .all(workspaceId) as unknown as AliasRow[];
  const aliasTargetOf = new Map<string, string>(
    aliasRows
      .filter((row): row is AliasRow & { aliased_node_id: string } => row.aliased_node_id !== null)
      .map((row) => [row.id, row.aliased_node_id]),
  );

  /** The alias-terminal of `id` (self when not an alias). Write-time cycle
   *  validation keeps chains acyclic; the visited set + cap are the
   *  belt-and-braces for data that predates the check. */
  const terminalCache = new Map<string, string>();
  const terminalOf = (id: string): string => {
    const cached = terminalCache.get(id);
    if (cached !== undefined) return cached;
    let current = id;
    const seen = new Set<string>();
    for (let depth = 0; depth < ALIAS_GRAPH_DEPTH_CAP; depth += 1) {
      const target = aliasTargetOf.get(current);
      if (target === undefined || seen.has(target)) break;
      seen.add(current);
      current = target;
    }
    terminalCache.set(id, current);
    return current;
  };

  /** Nearest node-set ancestor, stepping THROUGH aliases (blocks roll up;
   *  node-set nodes resolve to self; an alias resolves to its terminal). */
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
      const aliasTarget = aliasTargetOf.get(current);
      if (aliasTarget !== undefined) {
        current = aliasTarget;
        continue;
      }
      current = parentOf.get(current) ?? null;
    }
    for (const visited of seen) resolveCache.set(visited, result);
    return result;
  };

  const nodes: GraphNode[] = nodeRows.map((row) => {
    const metrics = metricsOf(row.id);
    return {
      id: row.id,
      isClass: row.is_class === 1,
      parentId: row.parent_id,
      classIds: JSON.parse(row.class_ids || "[]") as string[],
      color: row.color,
      icon: row.icon,
      contentSize: metrics.content,
      mass: metrics.mass,
    };
  });

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
  // Targets ride the applier-materialized resolved_target_id (the alias
  // terminal — graph.ts already steps through aliases, so this is the same
  // projection, one column read instead of a per-endpoint chain walk).
  const typedLinkRows = db
    .prepare(
      `SELECT source_id, resolved_target_id AS target_id, type FROM edge
       WHERE workspace_id = ? AND resolved_target_id IS NOT NULL AND type IN ('mention', 'property')`,
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
  // the day node ids as evidence (the parked design, now shipped).
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
      // Aliases are transparent here too: a context under an alias of a day
      // page belongs to the terminal's day, never the alias's.
      current = aliasTargetOf.get(current) ?? parentOf.get(current) ?? null;
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
  // The anchor steps through the alias-terminal too: an alias anchor shows
  // its terminal's neighborhood (the alias is never a vertex).
  const anchor = options?.anchor !== undefined ? resolveToSet(options.anchor) : undefined;
  if (anchor !== undefined && anchor !== null) {
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
