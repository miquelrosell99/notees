import { type Database } from 'sql.js';
import { queryAll } from '../db/sqlite';

interface StatRow {
  node_id: string;
  child_count: number;
  backlink_count: number;
  reference_count: number;
  descendant_count: number;
}

/**
 * Recompute materialized node counts from the derived tables.
 *
 * If `nodeIds` is omitted, all rows are rebuilt. If a list is provided, only
 * those rows are recomputed. Callers are responsible for running this inside a
 * transaction when needed.
 */
export function rebuildNodeStats(db: Database, nodeIds?: string[]): void {
  const now = new Date().toISOString();

  if (!nodeIds || nodeIds.length === 0) {
    db.run('DELETE FROM node_stats');

    const rows = queryAll<StatRow>(
      db,
      `
      WITH RECURSIVE descendants(ancestor_id, descendant_id) AS (
        SELECT parent_id, child_id FROM node_child_order
        UNION ALL
        SELECT d.ancestor_id, nco.child_id
        FROM descendants d
        JOIN node_child_order nco ON nco.parent_id = d.descendant_id
      ),
      descendant_counts AS (
        SELECT ancestor_id, COUNT(*) AS descendant_count
        FROM descendants
        GROUP BY ancestor_id
      ),
      child_counts AS (
        SELECT parent_id, COUNT(*) AS child_count
        FROM node_child_order
        GROUP BY parent_id
      ),
      backlink_counts AS (
        SELECT target_id, COUNT(DISTINCT source_id) AS backlink_count
        FROM edge
        WHERE type = 'reference'
        GROUP BY target_id
      ),
      reference_counts AS (
        SELECT source_id, COUNT(DISTINCT target_id) AS reference_count
        FROM edge
        WHERE type = 'reference'
        GROUP BY source_id
      )
      SELECT
        n.id AS node_id,
        COALESCE(cc.child_count, 0) AS child_count,
        COALESCE(bc.backlink_count, 0) AS backlink_count,
        COALESCE(rc.reference_count, 0) AS reference_count,
        COALESCE(dc.descendant_count, 0) AS descendant_count
      FROM node n
      LEFT JOIN child_counts cc ON cc.parent_id = n.id
      LEFT JOIN backlink_counts bc ON bc.target_id = n.id
      LEFT JOIN reference_counts rc ON rc.source_id = n.id
      LEFT JOIN descendant_counts dc ON dc.ancestor_id = n.id
      `
    );

    const stmt = db.prepare(
      'INSERT INTO node_stats (node_id, child_count, backlink_count, reference_count, descendant_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    try {
      for (const row of rows) {
        stmt.run([
          row.node_id,
          row.child_count,
          row.backlink_count,
          row.reference_count,
          row.descendant_count,
          now,
        ]);
      }
    } finally {
      stmt.free();
    }

    return;
  }

  // Deduplicate and filter empty IDs.
  const ids = Array.from(new Set(nodeIds)).filter((id) => id);
  if (ids.length === 0) return;

  const placeholders = ids.map(() => '?').join(',');
  db.run(`DELETE FROM node_stats WHERE node_id IN (${placeholders})`, ids);

  const targetedValues = ids.map((_id, index) => `(?, ${index})`).join(',');
  const rows = queryAll<StatRow>(
    db,
    `
    WITH RECURSIVE targeted(id, ord) AS (
      VALUES ${targetedValues}
    ),
    descendants(ancestor_id, descendant_id) AS (
      SELECT t.id, nco.child_id
      FROM targeted t
      JOIN node_child_order nco ON nco.parent_id = t.id
      UNION ALL
      SELECT d.ancestor_id, nco.child_id
      FROM descendants d
      JOIN node_child_order nco ON nco.parent_id = d.descendant_id
    ),
    descendant_counts AS (
      SELECT ancestor_id, COUNT(*) AS descendant_count
      FROM descendants
      GROUP BY ancestor_id
    ),
    child_counts AS (
      SELECT parent_id, COUNT(*) AS child_count
      FROM node_child_order
      WHERE parent_id IN (SELECT id FROM targeted)
      GROUP BY parent_id
    ),
    backlink_counts AS (
      SELECT target_id, COUNT(DISTINCT source_id) AS backlink_count
      FROM edge
      WHERE type = 'reference' AND target_id IN (SELECT id FROM targeted)
      GROUP BY target_id
    ),
    reference_counts AS (
      SELECT source_id, COUNT(DISTINCT target_id) AS reference_count
      FROM edge
      WHERE type = 'reference' AND source_id IN (SELECT id FROM targeted)
      GROUP BY source_id
    )
    SELECT
      t.id AS node_id,
      COALESCE(cc.child_count, 0) AS child_count,
      COALESCE(bc.backlink_count, 0) AS backlink_count,
      COALESCE(rc.reference_count, 0) AS reference_count,
      COALESCE(dc.descendant_count, 0) AS descendant_count
    FROM targeted t
    LEFT JOIN child_counts cc ON cc.parent_id = t.id
    LEFT JOIN backlink_counts bc ON bc.target_id = t.id
    LEFT JOIN reference_counts rc ON rc.source_id = t.id
    LEFT JOIN descendant_counts dc ON dc.ancestor_id = t.id
    ORDER BY t.ord
    `,
    ids
  );

  const stmt = db.prepare(
    'INSERT INTO node_stats (node_id, child_count, backlink_count, reference_count, descendant_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  try {
    for (const row of rows) {
      stmt.run([
        row.node_id,
        row.child_count,
        row.backlink_count,
        row.reference_count,
        row.descendant_count,
        now,
      ]);
    }
  } finally {
    stmt.free();
  }
}
