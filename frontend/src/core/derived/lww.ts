import { type Database } from 'sql.js';
import { compareHlc, type Hlc } from '../clock';
import { queryOne } from '../db/sqlite';

/**
 * Last-write-wins metadata for a derived value: the HLC of the operation
 * that last won the field, plus the actor id as the deterministic tiebreak
 * (mirrors the envelope sort order used by the sync engine).
 */
export interface LwwRecord {
  hlc: Hlc;
  actorId: string;
}

export function compareLww(incoming: LwwRecord, existing: LwwRecord): number {
  const hlcCmp = compareHlc(incoming.hlc, existing.hlc);
  if (hlcCmp !== 0) return hlcCmp;
  return incoming.actorId.localeCompare(existing.actorId);
}

function readNodeFieldRecord(
  db: Database,
  nodeId: string,
  field: string
): LwwRecord | undefined {
  const row = queryOne<{ hlc_physical: number; hlc_logical: number; actor_id: string }>(
    db,
    'SELECT hlc_physical, hlc_logical, actor_id FROM node_field_lww WHERE node_id = ? AND field = ?',
    [nodeId, field]
  );
  if (!row) return undefined;
  return { hlc: { physical: row.hlc_physical, logical: row.hlc_logical }, actorId: row.actor_id };
}

/**
 * Decide whether ``incoming`` may write a scalar node field, and if so stamp
 * the field's LWW record.
 *
 * Node fields (icon, color, active, parent, kind, class_ids) are plain
 * UPDATEs in the derived store; without this guard a late-arriving remote op
 * with an older HLC would regress a newer value applied optimistically
 * (or vice versa after a replay). Returns true when the caller should apply
 * its UPDATE.
 */
export function claimNodeField(
  db: Database,
  nodeId: string,
  field: string,
  incoming: LwwRecord
): boolean {
  const existing = readNodeFieldRecord(db, nodeId, field);
  if (existing && compareLww(incoming, existing) <= 0) {
    return false;
  }
  db.run(
    `INSERT INTO node_field_lww (node_id, field, hlc_physical, hlc_logical, actor_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(node_id, field) DO UPDATE SET
       hlc_physical = excluded.hlc_physical,
       hlc_logical = excluded.hlc_logical,
       actor_id = excluded.actor_id`,
    [nodeId, field, incoming.hlc.physical, incoming.hlc.logical, incoming.actorId]
  );
  return true;
}

/**
 * Read-only variant of :func:`claimNodeField`: true when ``incoming`` would
 * lose to the field's current record. Used by ops that must respect a
 * wholesale replace (``node.convert`` class_ids) without stamping it.
 */
export function nodeFieldClaimLost(
  db: Database,
  nodeId: string,
  field: string,
  incoming: LwwRecord
): boolean {
  const existing = readNodeFieldRecord(db, nodeId, field);
  return existing !== undefined && compareLww(incoming, existing) <= 0;
}
