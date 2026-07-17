import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { compareHlc, type Hlc } from '../clock';
import { queryOne } from '../db/sqlite';

interface LwwRecord {
  hlc: Hlc;
  actorId: string;
}

function compareLww(incoming: LwwRecord, existing: LwwRecord): number {
  const hlcCmp = compareHlc(incoming.hlc, existing.hlc);
  if (hlcCmp !== 0) return hlcCmp;
  return incoming.actorId.localeCompare(existing.actorId);
}

function recordFromRow(
  row: { hlc_physical: number; hlc_logical: number; actor_id: string | null } | undefined,
  fallbackActorId: string
): LwwRecord | undefined {
  if (!row) return undefined;
  return {
    hlc: { physical: row.hlc_physical, logical: row.hlc_logical },
    actorId: row.actor_id ?? fallbackActorId,
  };
}

interface PropertyKey {
  nodeId: string;
  schemaId: string;
  index: number;
}

function upsertTombstone(db: Database, key: PropertyKey, record: LwwRecord): void {
  db.run(
    `INSERT INTO property_value_tombstone (node_id, property_schema_id, idx, hlc_physical, hlc_logical, actor_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id, property_schema_id, idx) DO UPDATE SET
       hlc_physical = excluded.hlc_physical,
       hlc_logical = excluded.hlc_logical,
       actor_id = excluded.actor_id
     WHERE excluded.hlc_physical > hlc_physical
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical AND excluded.actor_id > actor_id)`,
    [key.nodeId, key.schemaId, key.index, record.hlc.physical, record.hlc.logical, record.actorId]
  );
}

function getTombstone(db: Database, key: PropertyKey, fallbackActorId: string): LwwRecord | undefined {
  const row = queryOne<{ hlc_physical: number; hlc_logical: number; actor_id: string | null }>(
    db,
    'SELECT hlc_physical, hlc_logical, actor_id FROM property_value_tombstone WHERE node_id = ? AND property_schema_id = ? AND idx = ?',
    [key.nodeId, key.schemaId, key.index]
  );
  return recordFromRow(row, fallbackActorId);
}

export function applyPropertyOperation(db: Database, op: Operation): void {
  const payload = op.payload as Record<string, unknown>;
  const incoming: LwwRecord = { hlc: op.envelope.hlc, actorId: op.envelope.actorId };
  const key: PropertyKey = {
    nodeId: payload.nodeId as string,
    schemaId: payload.schemaId as string,
    index: (payload.index as number) ?? 0,
  };

  if (op.envelope.opType === 'property.set') {
    const existingRow = queryOne<{
      id: string;
      hlc_physical: number;
      hlc_logical: number;
      actor_id: string | null;
    }>(
      db,
      'SELECT id, hlc_physical, hlc_logical, actor_id FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?',
      [key.nodeId, key.schemaId, key.index]
    );

    const existing = recordFromRow(existingRow, incoming.actorId);
    const tombstone = getTombstone(db, key, incoming.actorId);

    if (tombstone && compareLww(incoming, tombstone) <= 0) {
      return;
    }

    if (existing) {
      if (compareLww(incoming, existing) > 0) {
        db.run(
          'UPDATE property_value SET value = ?, hlc_physical = ?, hlc_logical = ?, actor_id = ? WHERE node_id = ? AND property_schema_id = ? AND idx = ?',
          [JSON.stringify(payload.value), incoming.hlc.physical, incoming.hlc.logical, incoming.actorId, key.nodeId, key.schemaId, key.index]
        );
      }
    } else {
      db.run(
        'INSERT INTO property_value (id, node_id, property_schema_id, value, idx, hlc_physical, hlc_logical, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          payload.propertyValueId as string,
          key.nodeId,
          key.schemaId,
          JSON.stringify(payload.value),
          key.index,
          incoming.hlc.physical,
          incoming.hlc.logical,
          incoming.actorId,
        ]
      );
    }
  } else if (op.envelope.opType === 'property.unset') {
    const existingRow = queryOne<{ hlc_physical: number; hlc_logical: number; actor_id: string | null }>(
      db,
      'SELECT hlc_physical, hlc_logical, actor_id FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?',
      [key.nodeId, key.schemaId, key.index]
    );

    const existing = recordFromRow(existingRow, incoming.actorId);

    upsertTombstone(db, key, incoming);

    if (existing) {
      if (compareLww(incoming, existing) > 0) {
        db.run('DELETE FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?', [
          key.nodeId,
          key.schemaId,
          key.index,
        ]);
      }
    }
  }
}
