/**
 * Materialized node counts (port of `frontend/src/core/derived/nodeStats.ts`).
 * child_count from node_child_order; backlink/reference counts from
 * the derived edge index (the unified reference index — mentions,
 * typed_link marks, node-typed property values); descendant_count via a
 * recursive CTE over node_child_order.
 *
 * `updated_at` mirrors the node row's own updated_at (the LWW-winning op),
 * so the table is order-invariant: different envelope orders that produce
 * the same semantic state produce the same rows, not just the same counts.
 */

import type { StoreDatabase } from "./types.js";

/** Ancestor closure of ``nodeIds`` (including the ids themselves). */
function getAncestorClosure(db: StoreDatabase, nodeIds: string[]): string[] {
  const placeholders = nodeIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `WITH RECURSIVE
        starting(id) AS (SELECT id FROM node WHERE id IN (${placeholders})),
        ancestors(id) AS (
          SELECT parent_id FROM node
          WHERE id IN (SELECT id FROM starting) AND parent_id IS NOT NULL
          UNION
          SELECT n.parent_id FROM ancestors a JOIN node n ON n.id = a.id
          WHERE n.parent_id IS NOT NULL
        )
       SELECT id FROM starting UNION SELECT id FROM ancestors`,
    )
    .all(...nodeIds) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Recompute node_stats rows for the given ids plus their ancestors (so
 * descendant counts stay correct all the way up to the roots). Ids without
 * a live node row (e.g. just hard-deleted) are skipped by the node join.
 */
export function rebuildNodeStats(db: StoreDatabase, nodeIds: string[]): void {
  let ids = Array.from(new Set(nodeIds)).filter((id) => id.length > 0);
  if (ids.length === 0) return;
  ids = Array.from(new Set(getAncestorClosure(db, ids).concat(ids)));

  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM node_stats WHERE node_id IN (${placeholders})`).run(...ids);

  const targetedValues = ids.map((_, index) => `(?, ${index})`).join(",");
  db.prepare(
    `WITH RECURSIVE targeted(id, ord) AS (VALUES ${targetedValues}),
      descendants(ancestor_id, descendant_id) AS (
        SELECT t.id, nco.child_id
        FROM targeted t JOIN node_child_order nco ON nco.parent_id = t.id
        UNION ALL
        SELECT d.ancestor_id, nco.child_id
        FROM descendants d JOIN node_child_order nco ON nco.parent_id = d.descendant_id
      ),
      descendant_counts AS (
        SELECT ancestor_id, COUNT(*) AS descendant_count FROM descendants GROUP BY ancestor_id
      ),
      child_counts AS (
        SELECT parent_id, COUNT(*) AS child_count FROM node_child_order
        WHERE parent_id IN (SELECT id FROM targeted) GROUP BY parent_id
      ),
      backlink_counts AS (
        SELECT target_id, COUNT(DISTINCT source_id) AS backlink_count FROM edge
        WHERE target_id IN (SELECT id FROM targeted) GROUP BY target_id
      ),
      reference_counts AS (
        SELECT source_id, COUNT(*) AS reference_count FROM edge
        WHERE source_id IN (SELECT id FROM targeted) GROUP BY source_id
      )
     INSERT INTO node_stats
       (node_id, child_count, backlink_count, reference_count, descendant_count, updated_at)
     SELECT
       t.id AS node_id,
       COALESCE(cc.child_count, 0) AS child_count,
       COALESCE(bc.backlink_count, 0) AS backlink_count,
       COALESCE(rc.reference_count, 0) AS reference_count,
       COALESCE(dc.descendant_count, 0) AS descendant_count,
       n.updated_at AS updated_at
     FROM targeted t
     JOIN node n ON n.id = t.id
     LEFT JOIN child_counts cc ON cc.parent_id = t.id
     LEFT JOIN backlink_counts bc ON bc.target_id = t.id
     LEFT JOIN reference_counts rc ON rc.source_id = t.id
     LEFT JOIN descendant_counts dc ON dc.ancestor_id = t.id
     ORDER BY t.ord`,
  ).run(...ids);
}
