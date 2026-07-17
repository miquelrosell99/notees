import { Database } from "bun:sqlite";
import type { Operation } from "../operation";
import { compareHlc, type Hlc } from "../clock";

interface LwwRecord {
  hlc: Hlc;
  actorId: string;
}

function compareLww(incoming: LwwRecord, existing: LwwRecord): number {
  const hlcCmp = compareHlc(incoming.hlc, existing.hlc);
  if (hlcCmp !== 0) return hlcCmp;
  // HLCs are equal: break ties deterministically by actor id.
  return incoming.actorId.localeCompare(existing.actorId);
}

function recordFromRow(row: { hlc_physical: number; hlc_logical: number; actor_id: string | null } | undefined, fallbackActorId: string): LwwRecord | undefined {
  if (!row) return undefined;
  return {
    hlc: { physical: row.hlc_physical, logical: row.hlc_logical },
    actorId: row.actor_id ?? fallbackActorId,
  };
}

function upsertTombstone(db: Database, key: { nodeId: string; schemaId: string; index: number }, record: LwwRecord): void {
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

function getTombstone(db: Database, key: { nodeId: string; schemaId: string; index: number }, fallbackActorId: string): LwwRecord | undefined {
  const row = db
    .query("SELECT hlc_physical, hlc_logical, actor_id FROM property_value_tombstone WHERE node_id = ? AND property_schema_id = ? AND idx = ?")
    .get(key.nodeId, key.schemaId, key.index) as { hlc_physical: number; hlc_logical: number; actor_id: string | null } | undefined;
  return recordFromRow(row, fallbackActorId);
}

export function applyPropertyOperation(db: Database, op: Operation): void {
  const payload = op.payload as any;
  const incoming: LwwRecord = { hlc: op.envelope.hlc, actorId: op.envelope.actorId };
  const key = { nodeId: payload.nodeId, schemaId: payload.schemaId, index: payload.index ?? 0 };

  if (op.envelope.opType === "property.set") {
    const existingRow = db
      .query("SELECT id, hlc_physical, hlc_logical, actor_id FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?")
      .get(key.nodeId, key.schemaId, key.index) as
      | { id: string; hlc_physical: number; hlc_logical: number; actor_id: string | null }
      | undefined;

    const existing = recordFromRow(existingRow, incoming.actorId);
    const tombstone = getTombstone(db, key, incoming.actorId);

    // A tombstone with a higher or equal-winning LWW record blocks the set.
    if (tombstone && compareLww(incoming, tombstone) <= 0) {
      return;
    }

    if (existing) {
      if (compareLww(incoming, existing) > 0) {
        db.run(
          "UPDATE property_value SET value = ?, hlc_physical = ?, hlc_logical = ?, actor_id = ? WHERE node_id = ? AND property_schema_id = ? AND idx = ?",
          [JSON.stringify(payload.value), incoming.hlc.physical, incoming.hlc.logical, incoming.actorId, key.nodeId, key.schemaId, key.index]
        );
      }
    } else {
      db.run(
        "INSERT INTO property_value (id, node_id, property_schema_id, value, idx, hlc_physical, hlc_logical, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [payload.propertyValueId, key.nodeId, key.schemaId, JSON.stringify(payload.value), key.index, incoming.hlc.physical, incoming.hlc.logical, incoming.actorId]
      );
    }
  } else if (op.envelope.opType === "property.unset") {
    const existingRow = db
      .query("SELECT hlc_physical, hlc_logical, actor_id FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?")
      .get(key.nodeId, key.schemaId, key.index) as
      | { hlc_physical: number; hlc_logical: number; actor_id: string | null }
      | undefined;

    const existing = recordFromRow(existingRow, incoming.actorId);

    // Upsert tombstone first so the delete is remembered even if no value exists.
    upsertTombstone(db, key, incoming);

    if (existing) {
      if (compareLww(incoming, existing) > 0) {
        db.run("DELETE FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?", [
          key.nodeId,
          key.schemaId,
          key.index,
        ]);
      }
    }
    // If there is no existing value, the tombstone still records the unset for future stale sets.
  }
}
