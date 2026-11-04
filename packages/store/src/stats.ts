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

/**
 * Bulk-replay deferral seam: while a collector Set is installed (Store's
 * beginBulk window), rebuildNodeStats only RECORDS the requested ids and
 * returns immediately — no ancestor walk, no DELETE/INSERT. The window's
 * endBulk then runs rebuildAllNodeStats over the whole table. Nothing in
 * the appliers reads node_stats, so deferring is invisible inside the
 * window.
 *
 * The bulk tail's table differs from the online incremental path in
 * reader-visible but benign ways (verified: the only reader, the web
 * client's getBacklinkCount, reads backlink_count with a ?? 0 fallback and
 * never touches class nodes or stats.updated_at):
 *  - ROWS: the tail writes a row for EVERY node (classes included); the
 *    online path only writes rows for nodes a stats-touching op reached —
 *    class nodes usually have none.
 *  - FIXED POINT: the tail is a pure read of the final node/edge/child-order
 *    state. The online path can carry rows it never revisited: a stale
 *    updated_at (an icon/color-only object.update changes node.updated_at
 *    without triggering a stats rebuild) and stale counts (the
 *    class-convert fixture's carrier converts a parented object to a class
 *    without rebuilding the ex-parent's row). Both are order-sensitive
 *    incremental artifacts; the tail heals them, which matches the
 *    documented invariant ("mirrors the node row's own updated_at"). The
 *    COUNT columns the tail writes are exactly what a direct query over the
 *    final derived tables returns.
 *
 * Module-level (not per-connection) because every backend the store ships is
 * synchronous and single-connection-per-Store: a bulk window runs to
 * completion without interleaving another store's applies. Store installs
 * and clears the collector around the window; nesting restores the previous
 * collector.
 *
 * VISIBILITY OF THE DEFERRED STATE: while a window is open, node_stats reads
 * as stale/empty. On the server that is unobservable — hydration runs the
 * window synchronously start-to-finish before any route serves a read. The
 * sync engine's resync window is different: it spans awaited network
 * fetches, so a mid-resync reader in the browser worker CAN observe the
 * deferred tables (a backlink badge reading 0 mid-resync). Accepted: a full
 * resync already invalidates the UI wholesale, and the window closes before
 * the engine reports "synced".
 *
 * TORN-WINDOW SAFETY: a window interrupted by process death leaves the
 * BULK_WINDOW_META_KEY marker on disk (beginBulk commits it before any bulk
 * work); the next Store.open runs the total tail before serving reads. So
 * the tables are never permanently unmaintained — in-process failure heals
 * via endBulk's tail, process death heals at open.
 */
let deferredCollector: Set<string> | null = null;

/** Install (or clear, with null) the deferral collector. Returns the
 *  previous collector so callers can nest. */
export function setNodeStatsDeferral(collector: Set<string> | null): Set<string> | null {
  const previous = deferredCollector;
  deferredCollector = collector;
  return previous;
}

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
  if (deferredCollector !== null) {
    for (const id of ids) deferredCollector.add(id);
    return;
  }
  ids = Array.from(new Set(getAncestorClosure(db, ids).concat(ids)));
  replaceStatsRows(db, ids);
}

/**
 * The bulk-replay tail: recompute the WHOLE node_stats table in one pass
 * (the beginBulk window's deferred maintenance). Rows are a pure function
 * of the final node/edge/child-order state, so this converges to the same
 * table the per-op incremental path would have produced — at O(sum of
 * subtree sizes) instead of O(ops × ancestor-chain subtree scans).
 */
export function rebuildAllNodeStats(db: StoreDatabase): void {
  db.exec("DELETE FROM node_stats");
  // Every node row gets a stats row — the incremental path's node JOIN has
  // no liveness filter (trashed/archived rows keep their counts), and the
  // full rebuild must converge to the same table.
  const rows = db.prepare("SELECT id FROM node ORDER BY id").all() as {
    id: string;
  }[];
  replaceStatsRows(
    db,
    rows.map((r) => r.id),
  );
}

/**
 * DELETE + re-INSERT the stats rows for exactly `ids` (chunked — the
 * placeholder count stays under conservative SQLite variable limits on every
 * backend). Shared by the incremental and the full-table rebuilds.
 */
function replaceStatsRows(db: StoreDatabase, ids: string[]): void {
  if (ids.length === 0) return;
  const CHUNK = 900;
  for (let start = 0; start < ids.length; start += CHUNK) {
    const chunk = ids.slice(start, start + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM node_stats WHERE node_id IN (${placeholders})`).run(...chunk);

    const targetedValues = chunk.map((_, index) => `(?, ${index})`).join(",");
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
    ).run(...chunk);
  }
}
