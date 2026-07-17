import { Database } from "bun:sqlite";
import type { Operation } from "../operation";

export function applyPropertyOperation(db: Database, op: Operation): void {
  const payload = op.payload as any;

  if (op.envelope.opType === "property.set") {
    const existing = db
      .query("SELECT id FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?")
      .get(payload.nodeId, payload.schemaId, payload.index ?? 0);
    if (existing) {
      db.run(
        "UPDATE property_value SET value = ? WHERE node_id = ? AND property_schema_id = ? AND idx = ?",
        [JSON.stringify(payload.value), payload.nodeId, payload.schemaId, payload.index ?? 0]
      );
    } else {
      db.run(
        "INSERT INTO property_value (id, node_id, property_schema_id, value, idx) VALUES (?, ?, ?, ?, ?)",
        [payload.propertyValueId, payload.nodeId, payload.schemaId, JSON.stringify(payload.value), payload.index ?? 0]
      );
    }
  } else if (op.envelope.opType === "property.unset") {
    db.run("DELETE FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?", [
      payload.nodeId,
      payload.schemaId,
      payload.index ?? 0,
    ]);
  }
}
