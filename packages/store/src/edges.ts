/**
 * Edge-index derivation (port of `derived/edge.py` — edge is the single
 * derived reference index, never authored).
 *
 * For a source node, rebuildEdges synchronizes three families of edges from
 * the node's current derived state:
 *
 *  - ``mention``      — mention tokens (edge per instance; node_link
 *                       assertion row only when the token carries linkId);
 *  - ``typed_link``   — typed-link word marks, top-level and inside quotes
 *                       (SCHEMA.md: a mark on a prose word — the association
 *                       dies with its word). target_id is NULL by design:
 *                       candidateSpans are recorded, resolution is deferred;
 *  - ``property``     — node-typed property values ({ "nodeId": ... }),
 *                       verb = propertySchemaId.
 *
 * PB1 (SCHEMA.md "Broken references", owner rule 2026-10-04): the property
 * family derives from the SURVIVING value rows, never from target liveness
 * — a value pointing at a deleted/trashed node keeps its edge (rebuild
 * re-derives it identically; it must never drop a broken ref silently, and
 * the permanent-delete applier keeps incoming rows for the same reason).
 * Trashed targets therefore keep backlinks for free; a restored target
 * heals its backlink set only because the rows survived. Ghost-target rows
 * are inert — every query here is keyed by a live node id.
 *
 * Edge ids are deterministic (sha256 over source/type/target/verb/metadata/
 * occurrence), so wipe -> replay -> identical rows. Stale edges and node_link
 * assertions for the source are deleted; ``node_stats`` is recomputed for the
 * source and every target whose backlink set may have changed.
 *
 * resolved_target_id (store schema v17): every edge row carries the
 * alias-terminal of its target, materialized BY THE APPLIER at write time —
 * the backlinks roll-up and the graph read the column instead of walking
 * alias chains per query. Resolution walks `aliased_node_id` chains exactly
 * like Store.resolveAlias (cycle-safe: a revisit yields the STARTING id
 * unchanged; depth-capped), with one deliberate difference: LIVE rows only —
 * a trashed or deleted node never resolves through (a trashed alias's edges
 * stay on the alias, inert, matching the live-only roll-up the client
 * unioned from aliasNodesOf); a missing/inactive row is its own terminal.
 * Non-alias targets resolve to their own id; targetless typed_link rows
 * carry NULL. The column is a pure function of the node rows, so it
 * converges under any delivery order and replays byte-identical.
 */

import { createHash } from "node:crypto";

import { monthNodeId, parseDateNodeId, yearNodeId } from "@notees/domain";
import type { ContentAst } from "@notees/protocol";

import type { SqliteDB } from "./db.js";
import { parseContentAst } from "./content.js";
import { rebuildNodeStats } from "./stats.js";
import { visiblePropertyValueRows } from "./property-values.js";
import type { StoreDatabase } from "./types.js";

/** The alias-chain walker's depth cap (chains are user-built and tiny; the
 *  cap bounds pathological data — on exhaustion the furthest node is the
 *  best-effort terminal). Shared by the store reads and the edge
 *  resolution walk. */
export const ALIAS_CHAIN_DEPTH_CAP = 32;

/** Minimal DB surface the resolution walk needs (migrate()'s backfill runs
 *  on a connection typed narrower than StoreDatabase). */
type ResolutionDB = Pick<SqliteDB, "prepare">;

/**
 * The alias-terminal of an edge target, materialized at edge-write time:
 * follow `aliased_node_id` links to the final live node — a non-alias
 * target resolves to its own id, a NULL target (typed_link) to NULL. The
 * walk mirrors Store.resolveAlias's cycle rule (a revisit yields the
 * starting id unchanged) with the liveness gate described above. Pure
 * function of the node table; deterministic, so wipe -> replay converges.
 */
export function resolveEdgeTarget(db: ResolutionDB, targetId: string | null): string | null {
  if (targetId === null) return null;
  const stmt = db.prepare("SELECT aliased_node_id, is_active FROM node WHERE id = ?");
  const visited = new Set<string>();
  let current = targetId;
  for (let depth = 0; depth < ALIAS_CHAIN_DEPTH_CAP; depth += 1) {
    if (visited.has(current)) return targetId; // cycle — the starting id unchanged
    visited.add(current);
    const row = stmt.get(current) as
      | { aliased_node_id: string | null; is_active: number }
      | undefined;
    if (row === undefined || row.is_active !== 1 || row.aliased_node_id === null) {
      return current;
    }
    current = row.aliased_node_id;
  }
  return current; // depth cap — best-effort terminal
}

/**
 * Re-materialize resolved_target_id after anything that can shift alias
 * chains: an object.update writing `aliasedNodeId`, or a liveness flip
 * (trash / restore / permanent delete / archival) of any node that is IN a
 * chain. For every seed id the reverse closure over `aliased_node_id`
 * (every LIVE node whose alias chain passes through the seed — pointer-
 * based, invariant under the seed's own edit or liveness flip) plus the
 * seed itself re-resolves its edge rows. Idempotent and cheap when no
 * aliases involve the seeds (the closure is the seed alone).
 */
export function reresolveEdgeTargets(db: StoreDatabase, nodeIds: string[]): void {
  const closureOf = db.prepare(
    `WITH RECURSIVE rev(id) AS (
       SELECT ?
       UNION
       SELECT n.id FROM node n JOIN rev r ON n.aliased_node_id = r.id
       WHERE n.is_active = 1
     )
     SELECT id FROM rev`,
  );
  const targets = new Set<string>();
  for (const id of nodeIds) {
    if (id.length === 0) continue;
    const rows = closureOf.all(id) as Array<{ id: string }>;
    for (const row of rows) targets.add(row.id);
  }
  const update = db.prepare("UPDATE edge SET resolved_target_id = ? WHERE target_id = ?");
  for (const target of targets) {
    update.run(resolveEdgeTarget(db, target), target);
  }
}

export interface DesiredEdge {
  targetId: string | null;
  type: "mention" | "typed_link" | "property";
  verb: string | null;
  metadata: string | null;
}

export interface EdgeRebuildResult {
  /** Nodes whose backlink/reference counts may have changed. */
  affectedNodeIds: string[];
}

function edgeId(sourceId: string, edge: DesiredEdge, occurrence: number): string {
  return createHash("sha256")
    .update(
      [sourceId, edge.type, edge.targetId ?? "", edge.verb ?? "", edge.metadata ?? "", occurrence].join(
        "\u0000",
      ),
    )
    .digest("hex");
}

/** Collect the desired edge multiset for one node. */
export function deriveDesiredEdges(db: StoreDatabase, nodeId: string): DesiredEdge[] {
  const row = db.prepare("SELECT content FROM node WHERE id = ?").get(nodeId) as
    | { content: string }
    | undefined;
  if (!row) return [];
  const ast = parseContentAst(row.content);

  const desired: DesiredEdge[] = [];
  const walk = (tokens: readonly unknown[]): void => {
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as Record<string, unknown>;
      if (t.type === "mention" && typeof t.targetNodeId === "string") {
        desired.push({
          targetId: t.targetNodeId,
          type: "mention",
          verb: null,
          metadata: null,
        });
      } else if (t.type === "typed_link") {
        const verb =
          typeof t.verb === "string"
            ? t.verb
            : typeof t.verb === "object" && t.verb !== null && "propertySchemaId" in t.verb
              ? String((t.verb as { propertySchemaId: unknown }).propertySchemaId)
              : null;
        const metadata =
          typeof t.metadata === "object" && t.metadata !== null ? JSON.stringify(t.metadata) : null;
        const text = typeof t.text === "string" ? t.text : null;
        const fullMetadata =
          metadata === null && text === null
            ? null
            : JSON.stringify({ ...(metadata ? (JSON.parse(metadata) as object) : {}), ...(text !== null ? { text } : {}) });
        desired.push({ targetId: null, type: "typed_link", verb, metadata: fullMetadata });
      } else if (t.type === "quote" && Array.isArray(t.children)) {
        walk(t.children);
      }
    }
  };
  walk(ast);

  // Node-typed property values project into the edge index (verb = schema).
  // Keying is VALUE-SHAPE based, not type-based, so datetime refs
  // ({ "nodeId": … } point or { "start", "end" } slots on datetime schemas)
  // project like any node-typed value. A date ref also fans
  // out to its deterministic chain ANCESTORS (SCHEMA.md "Datetime": "backlinks
  // on a year node list everything dated that year") — ids are
  // content-addressed (domain dates.ts), so a day ref implies the month and
  // year edges, a month ref the year edge. Range values ({ start, end }
  // of slots, either side open) project each present end the same way.
  // PG5: the rows come through the visible-set derivation (property-values.ts)
  // — a tombstoned element's edges vanish with it (edge rebuild consistency).
  const propertyRows = visiblePropertyValueRows(db, nodeId).sort(
    (a, b) =>
      a.property_schema_id.localeCompare(b.property_schema_id) ||
      a.idx - b.idx ||
      (a.id < b.id ? -1 : 1),
  );
  const pushRefEdge = (
    propertySchemaId: string,
    ref: unknown,
    metadata: string | null,
  ): void => {
    if (typeof ref !== "object" || ref === null || !("nodeId" in ref)) return;
    const target = (ref as { nodeId: unknown }).nodeId;
    if (typeof target !== "string" || target.length === 0) return;
    desired.push({ targetId: target, type: "property", verb: propertySchemaId, metadata });
    // Date-chain ancestors: the ref claims its own precision; coarser periods
    // are implied. Deterministic ids keep wipe -> replay identical.
    const parsed = parseDateNodeId(target);
    if (parsed !== null) {
      const iso = `${String(parsed.year).padStart(4, "0")}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
      if (parsed.precision === "day") {
        desired.push({ targetId: monthNodeId(iso), type: "property", verb: propertySchemaId, metadata });
      }
      if (parsed.precision === "day" || parsed.precision === "month") {
        desired.push({ targetId: yearNodeId(iso), type: "property", verb: propertySchemaId, metadata });
      }
    }
  };
  for (const pr of propertyRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(pr.value);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && "nodeId" in parsed) {
      pushRefEdge(pr.property_schema_id, parsed, pr.metadata);
    } else if (typeof parsed === "object" && parsed !== null) {
      const range = parsed as { start?: unknown; end?: unknown };
      pushRefEdge(pr.property_schema_id, range.start, pr.metadata);
      pushRefEdge(pr.property_schema_id, range.end, pr.metadata);
    }
  }

  return desired;
}

/**
 * Synchronize edge + node_link rows for ``nodeId`` and refresh node_stats
 * for the source and all affected targets. ``at`` is the applying envelope's
 * timestamp (deterministic derived rows).
 */
export function rebuildEdges(db: StoreDatabase, nodeId: string, at: string): EdgeRebuildResult {
  const nodeRow = db.prepare("SELECT workspace_id FROM node WHERE id = ?").get(nodeId) as
    | { workspace_id: string }
    | undefined;
  const workspaceId = nodeRow?.workspace_id ?? null;

  const previousTargets = (
    db.prepare("SELECT target_id FROM edge WHERE source_id = ?").all(nodeId) as {
      target_id: string | null;
    }[]
  ).map((r) => r.target_id);

  if (!nodeRow) {
    // Node gone: drop everything this source ever derived.
    db.prepare("DELETE FROM edge WHERE source_id = ?").run(nodeId);
    db.prepare("DELETE FROM node_link WHERE source_id = ?").run(nodeId);
    rebuildNodeStats(db, [nodeId]);
    return { affectedNodeIds: [nodeId] };
  }

  const desired = deriveDesiredEdges(db, nodeId);

  // --- node_link assertions (mention tokens carrying linkId) --------------
  const row = db.prepare("SELECT content FROM node WHERE id = ?").get(nodeId) as { content: string };
  const ast: ContentAst = parseContentAst(row.content);
  const desiredLinkIds = new Set<string>();
  const upsertLink = db.prepare(
    `INSERT INTO node_link (id, workspace_id, source_id, target_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source_id = excluded.source_id,
       target_id = excluded.target_id,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
  );
  const walkLinks = (tokens: readonly unknown[]): void => {
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as Record<string, unknown>;
      if (t.type === "mention" && typeof t.linkId === "string" && typeof t.targetNodeId === "string") {
        desiredLinkIds.add(t.linkId);
        upsertLink.run(t.linkId, workspaceId, nodeId, t.targetNodeId, at, at);
      } else if (t.type === "quote" && Array.isArray(t.children)) {
        walkLinks(t.children);
      }
    }
  };
  walkLinks(ast);

  const existingLinkIds = (
    db.prepare("SELECT id FROM node_link WHERE source_id = ?").all(nodeId) as { id: string }[]
  ).map((r) => r.id);
  const deleteLink = db.prepare("DELETE FROM node_link WHERE id = ?");
  for (const id of existingLinkIds) {
    if (!desiredLinkIds.has(id)) deleteLink.run(id);
  }

  // --- edge rows ------------------------------------------------------------
  const desiredIds = new Set<string>();
  const occurrenceByKey = new Map<string, number>();
  const insertEdge = db.prepare(
    `INSERT INTO edge (id, workspace_id, source_id, target_id, resolved_target_id, type, verb, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       created_at = excluded.created_at,
       resolved_target_id = excluded.resolved_target_id`,
  );
  // Resolution is a pure function of the target id — cache within the rebuild.
  const resolvedCache = new Map<string, string | null>();
  const resolvedOf = (targetId: string | null): string | null => {
    if (targetId === null) return null;
    const cached = resolvedCache.get(targetId);
    if (cached !== undefined) return cached;
    const resolved = resolveEdgeTarget(db, targetId);
    resolvedCache.set(targetId, resolved);
    return resolved;
  };
  for (const edge of desired) {
    const key = [edge.type, edge.targetId ?? "", edge.verb ?? "", edge.metadata ?? ""].join("\u0000");
    const occurrence = occurrenceByKey.get(key) ?? 0;
    occurrenceByKey.set(key, occurrence + 1);
    const id = edgeId(nodeId, edge, occurrence);
    desiredIds.add(id);
    // Content-derived edges stamp the applying (LWW-winning) op; property
    // edges carry their causal stamp in property_value.hlc_* and stay NULL
    // so cross-order replays do not diverge on a pass-through timestamp.
    const createdAt = edge.type === "property" ? null : at;
    insertEdge.run(
      id,
      workspaceId,
      nodeId,
      edge.targetId,
      resolvedOf(edge.targetId),
      edge.type,
      edge.verb,
      edge.metadata,
      createdAt,
    );
  }

  const existingEdges = db
    .prepare("SELECT id, target_id FROM edge WHERE source_id = ?")
    .all(nodeId) as { id: string; target_id: string | null }[];
  const deleteEdge = db.prepare("DELETE FROM edge WHERE id = ?");
  for (const existing of existingEdges) {
    if (!desiredIds.has(existing.id)) deleteEdge.run(existing.id);
  }

  // --- node_stats for source and every target that gained/lost a backlink ---
  const affected = new Set<string>([nodeId]);
  for (const t of previousTargets) if (t) affected.add(t);
  for (const edge of desired) if (edge.targetId) affected.add(edge.targetId);
  rebuildNodeStats(db, [...affected]);

  return { affectedNodeIds: [...affected] };
}
