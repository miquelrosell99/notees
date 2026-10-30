/**
 * forward-paths.ts — the "Forward path" page-section read (the first
 * non-query system section): a derived, directed, cycle-safe trace over the
 * node's CONSUMER edges — where an idea went next (embedded-in → synthesis →
 * plan).
 *
 * Direction: the edge table records mention AUTHOREDSHIP (source mentions
 * target); the forward direction is the mirror — a hop from node N leads to
 * a node that CONSUMES N (its content carries N as an embed, mentions N, or
 * verb-marks N). Every hop is traversed target→source against the edge
 * table's authorship direction; each PathRow names the node at its position
 * (row 0 = the anchor) plus the kind/verb of the edge leading from that row
 * to the NEXT row (null on the terminal row).
 *
 * Hop families:
 *  - embed      — a live node whose content carries an `embed_ref` token for
 *                 N (embeds ride content ASTs, never edges), or a mention
 *                 edge with the per-link transclusion flag (is_embedded = 1);
 *  - mention    — a mention edge without the flag (resolved_target_id, so
 *                 alias-terminal mentions roll up);
 *  - typed_link — a typed-link mark whose FIRST candidateSpan (nearest
 *                 mention target, record-don't-resolve) is N; the row carries
 *                 the verb. Non-first candidates never hop: an unresolved
 *                 verb claiming every candidate would be noise.
 *
 * Bounds: one path per simple chain (DFS, visited set per branch — a→b→a
 * terminates), depthCap hops (default 3), a path-count cap against
 * pathological branching, LIVE consumers only (trashed/deleted nodes never
 * claim a hop). An isolated or unknown anchor reads [] — no chains, no
 * single-anchor path.
 *
 * Cost note: the read is lazy behind the section's first expand (the
 * SCHEMA.md lazy-loading contract); the typed-link family scans the
 * workspace's typed-link edge rows per hop and the embed family one content
 * prefilter scan — bounded by the caps above.
 */

import type { Store } from "./store.js";
import { parseContentAst } from "./content.js";

export type ForwardPathEdgeKind = "embed" | "mention" | "typed_link";

export interface PathRow {
  /** The node at this position in the path (row 0 = the anchor node). */
  nodeId: string;
  /** The forward edge kind from this row's node to the path's next row; null on the terminal row. */
  kind: ForwardPathEdgeKind | null;
  /** The typed-link verb from this row's node to the next; null otherwise. */
  verb: string | null;
}

/** The default walk depth in hops (the section contract). */
export const FORWARD_PATH_DEPTH_CAP = 3;

/** Breadth safety valve: the walk stops enumerating chains past this many. */
const FORWARD_PATH_PATH_CAP = 64;

/** Dedupe/tiebreak rank — a stronger claim about the same consumer wins:
 *  an actual transclusion beats a verb-mark, a verb-mark beats a plain
 *  mention (the mention often exists only as the verb's candidate). */
const KIND_RANK: Record<ForwardPathEdgeKind, number> = { embed: 0, typed_link: 1, mention: 2 };

interface ConsumerEdge {
  to: string;
  kind: ForwardPathEdgeKind;
  verb: string | null;
}

export function forwardPaths(store: Store, nodeId: string, opts?: { depthCap?: number }): PathRow[][] {
  const db = store.database;
  const depthCap = opts?.depthCap ?? FORWARD_PATH_DEPTH_CAP;
  if (depthCap <= 0) return [];

  const anchor = db
    .prepare("SELECT workspace_id FROM node WHERE id = ?")
    .get(nodeId) as { workspace_id: string } | undefined;
  if (anchor === undefined) return [];
  const ws = anchor.workspace_id;

  const liveStmt = db.prepare("SELECT 1 AS live FROM node WHERE id = ? AND is_active = 1");
  const live = (id: string): boolean => liveStmt.get(id) !== undefined;

  const mentionStmt = db.prepare(
    `SELECT source_id, is_embedded FROM edge
     WHERE workspace_id = ? AND resolved_target_id = ? AND type = 'mention'
     ORDER BY source_id`,
  );
  const typedLinkStmt = db.prepare(
    `SELECT source_id, verb, metadata FROM edge
     WHERE workspace_id = ? AND type = 'typed_link'
     ORDER BY source_id`,
  );
  const embedCarrierStmt = db.prepare(
    `SELECT id, content FROM node
     WHERE workspace_id = ? AND is_active = 1 AND content LIKE '%embed_ref%'
     ORDER BY id`,
  );

  /** Every live consumer of `id`, one edge per consumer (strongest claim wins). */
  const consumersOf = (id: string): ConsumerEdge[] => {
    const byTarget = new Map<string, ConsumerEdge>();
    const put = (edge: ConsumerEdge): void => {
      const existing = byTarget.get(edge.to);
      if (existing !== undefined && KIND_RANK[existing.kind] <= KIND_RANK[edge.kind]) return;
      byTarget.set(edge.to, edge);
    };

    for (const row of mentionStmt.all(ws, id) as Array<{ source_id: string; is_embedded: number }>) {
      if (!live(row.source_id)) continue;
      put({ to: row.source_id, kind: row.is_embedded === 1 ? "embed" : "mention", verb: null });
    }

    for (const row of typedLinkStmt.all(ws) as Array<{ source_id: string; verb: string | null; metadata: string | null }>) {
      if (!live(row.source_id)) continue;
      let nearest: unknown = null;
      if (row.metadata !== null) {
        try {
          const spans = (JSON.parse(row.metadata) as { candidateSpans?: unknown }).candidateSpans;
          nearest = Array.isArray(spans) ? spans[0] : null;
        } catch {
          nearest = null;
        }
      }
      if (nearest !== id) continue;
      put({ to: row.source_id, kind: "typed_link", verb: row.verb });
    }

    for (const row of embedCarrierStmt.all(ws) as Array<{ id: string; content: string }>) {
      const walk = (tokens: readonly unknown[]): boolean => {
        for (const token of tokens) {
          if (typeof token !== "object" || token === null) continue;
          const t = token as Record<string, unknown>;
          if (t.type === "embed_ref" && t.nodeId === id) return true;
          if (t.type === "quote" && Array.isArray(t.children) && walk(t.children)) return true;
          if (t.type === "heading" && Array.isArray(t.children) && walk(t.children)) return true;
        }
        return false;
      };
      if (walk(parseContentAst(row.content))) put({ to: row.id, kind: "embed", verb: null });
    }

    return [...byTarget.values()].sort(
      (a, b) => KIND_RANK[a.kind]! - KIND_RANK[b.kind]! || a.to.localeCompare(b.to),
    );
  };

  const paths: PathRow[][] = [];
  const dfs = (rows: PathRow[], visited: Set<string>): void => {
    if (paths.length >= FORWARD_PATH_PATH_CAP) return;
    const current = rows[rows.length - 1]!.nodeId;
    if (rows.length - 1 >= depthCap) {
      paths.push([...rows]);
      return;
    }
    const hops = consumersOf(current).filter((hop) => !visited.has(hop.to));
    if (hops.length === 0) {
      if (rows.length > 1) paths.push([...rows]);
      return;
    }
    for (const hop of hops) {
      if (paths.length >= FORWARD_PATH_PATH_CAP) return;
      rows[rows.length - 1] = { nodeId: current, kind: hop.kind, verb: hop.verb };
      rows.push({ nodeId: hop.to, kind: null, verb: null });
      visited.add(hop.to);
      dfs(rows, visited);
      visited.delete(hop.to);
      rows.pop();
      rows[rows.length - 1] = { nodeId: current, kind: null, verb: null };
    }
  };
  dfs([{ nodeId, kind: null, verb: null }], new Set([nodeId]));
  return paths;
}
