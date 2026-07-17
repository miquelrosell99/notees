import { Database } from "bun:sqlite";
import type { Operation } from "../operation";
import { compareHlc } from "../clock";

export function applyPropertyOperation(db: Database, op: Operation): void {
  const payload = op.payload as any;

  if (op.envelope.opType === "property.set") {
    const incomingHlc = op.envelope.hlc;
    const existing = db
      .query("SELECT id, hlc_physical, hlc_logical FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?")
      .get(payload.nodeId, payload.schemaId, payload.index ?? 0) as
      | { id: string; hlc_physical: number; hlc_logical: number }
      | undefined;
    if (existing) {
      const existingHlc = { physical: existing.hlc_physical, logical: existing.hlc_logical };
      if (compareHlc(incomingHlc, existingHlc) > 0) {
        db.run(
          "UPDATE property_value SET value = ?, hlc_physical = ?, hlc_logical = ? WHERE node_id = ? AND property_schema_id = ? AND idx = ?",
          [JSON.stringify(payload.value), incomingHlc.physical, incomingHlc.logical, payload.nodeId, payload.schemaId, payload.index ?? 0]
        );
      }
    } else {
      db.run(
        "INSERT INTO property_value (id, node_id, property_schema_id, value, idx, hlc_physical, hlc_logical) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [payload.propertyValueId, payload.nodeId, payload.schemaId, JSON.stringify(payload.value), payload.index ?? 0, incomingHlc.physical, incomingHlc.logical]
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
