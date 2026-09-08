import { type Database } from 'sql.js';
import { compareHlc } from '../clock';
import type { LwwRecord } from './lww';
import { queryAll, queryOne } from '../db/sqlite';

/**
 * OR-Set (add-wins) class membership.
 *
 * Each (node, class) pair has one row recording the HLC/actor of the winning
 * claim and whether that claim was an add or a remove. Claims resolve by HLC
 * with adds winning at equal HLC — concurrent assign and unassign of the same
 * class always leaves the element PRESENT. Per-element LWW would drop the
 * element on the actor tiebreak, and the whole-set LWW this replaces could
 * lose elements under reordering entirely.
 *
 * `node.class_ids` is a materialization of this set, recomputed on every
 * membership change, so replay of the same op set always yields the same
 * derived state.
 */

interface MembershipRow {
  hlc_physical: number;
  hlc_logical: number;
  actor_id: string;
  present: number;
}

function readMembership(db: Database, nodeId: string, classId: string): MembershipRow | undefined {
  return queryOne<MembershipRow>(
    db,
    'SELECT hlc_physical, hlc_logical, actor_id, present FROM class_member_set WHERE node_id = ? AND class_id = ?',
    [nodeId, classId]
  );
}

/**
 * Record an assign (present=true) or unassign (present=false) claim under
 * OR-Set semantics. Returns true when the claim won and the materialized
 * class_ids must be recomputed.
 *
 * Resolution: strictly higher HLC wins in either direction; at equal HLC the
 * add wins, so a concurrent assign/unassign leaves the element present in
 * every arrival order.
 */
export function claimClassMembership(
  db: Database,
  nodeId: string,
  classId: string,
  incoming: LwwRecord,
  present: boolean
): boolean {
  const existing = readMembership(db, nodeId, classId);
  if (existing) {
    const hlcCmp = compareHlc(incoming.hlc, {
      physical: existing.hlc_physical,
      logical: existing.hlc_logical,
    });
    if (hlcCmp < 0) return false;
    if (hlcCmp === 0 && !present && existing.present === 1) {
      // Equal HLC: the recorded add beats the incoming remove.
      return false;
    }
  }
  db.run(
    `INSERT INTO class_member_set (node_id, class_id, hlc_physical, hlc_logical, actor_id, present)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id, class_id) DO UPDATE SET
       hlc_physical = excluded.hlc_physical,
       hlc_logical = excluded.hlc_logical,
       actor_id = excluded.actor_id,
       present = excluded.present`,
    [nodeId, classId, incoming.hlc.physical, incoming.hlc.logical, incoming.actorId, present ? 1 : 0]
  );
  return true;
}

/** Recompute node.class_ids from the membership set. */
export function recomputeClassIds(db: Database, nodeId: string, actorId: string): void {
  const rows = queryAll<{ class_id: string }>(
    db,
    'SELECT class_id FROM class_member_set WHERE node_id = ? AND present = 1 ORDER BY class_id',
    [nodeId]
  );
  db.run('UPDATE node SET class_ids = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
    JSON.stringify(rows.map((row) => row.class_id)),
    new Date().toISOString(),
    actorId,
    nodeId,
  ]);
}

/** The newest membership claim for a node, or undefined. Used by node.convert's wholesale-replace guard. */
export function maxClassMembershipRecord(db: Database, nodeId: string): LwwRecord | undefined {
  const row = queryOne<{ hlc_physical: number; hlc_logical: number; actor_id: string }>(
    db,
    `SELECT hlc_physical, hlc_logical, actor_id FROM class_member_set
     WHERE node_id = ?
     ORDER BY hlc_physical DESC, hlc_logical DESC, actor_id DESC
     LIMIT 1`,
    [nodeId]
  );
  if (!row) return undefined;
  return { hlc: { physical: row.hlc_physical, logical: row.hlc_logical }, actorId: row.actor_id };
}
