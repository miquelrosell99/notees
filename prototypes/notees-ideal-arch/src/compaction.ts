import { Database } from "bun:sqlite";
import { uuidv7 } from "./uuid";

export interface CompactionSegment {
  id: string;
  workspaceId: string;
  fromHlcPhysical: number;
  fromHlcLogical: number;
  toHlcPhysical: number;
  toHlcLogical: number;
  snapshotId: string;
  operationCount: number;
}

export function createCompactionSegment(db: Database, workspaceId: string, snapshotId: string): CompactionSegment {
  const snap = db
    .query("SELECT hlc_physical, hlc_logical FROM snapshot WHERE id = ?")
    .get(snapshotId) as { hlc_physical: number; hlc_logical: number };

  const firstOp = db
    .query("SELECT hlc_physical, hlc_logical FROM operation WHERE workspace_id = ? ORDER BY hlc_physical ASC, hlc_logical ASC LIMIT 1")
    .get(workspaceId) as { hlc_physical: number; hlc_logical: number } | undefined;

  const countRow = db
    .query(`SELECT COUNT(*) as c FROM operation
            WHERE workspace_id = ?
              AND (hlc_physical < ? OR (hlc_physical = ? AND hlc_logical <= ?))`)
    .get(workspaceId, snap.hlc_physical, snap.hlc_physical, snap.hlc_logical) as { c: number };

  const id = uuidv7();
  const fromHlcPhysical = firstOp?.hlc_physical ?? snap.hlc_physical;
  const fromHlcLogical = firstOp?.hlc_logical ?? snap.hlc_logical;

  db.run(
    `INSERT INTO compacted_operation_segment
     (id, workspace_id, from_hlc_physical, from_hlc_logical, to_hlc_physical, to_hlc_logical, snapshot_id, operation_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workspaceId,
      fromHlcPhysical,
      fromHlcLogical,
      snap.hlc_physical,
      snap.hlc_logical,
      snapshotId,
      countRow.c,
      new Date().toISOString(),
    ]
  );

  return {
    id,
    workspaceId,
    fromHlcPhysical,
    fromHlcLogical,
    toHlcPhysical: snap.hlc_physical,
    toHlcLogical: snap.hlc_logical,
    snapshotId,
    operationCount: countRow.c,
  };
}

export function listCompactionSegments(db: Database, workspaceId: string): CompactionSegment[] {
  const rows = db
    .query("SELECT * FROM compacted_operation_segment WHERE workspace_id = ? ORDER BY to_hlc_physical ASC, to_hlc_logical ASC")
    .all(workspaceId) as any[];
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    fromHlcPhysical: r.from_hlc_physical,
    fromHlcLogical: r.from_hlc_logical,
    toHlcPhysical: r.to_hlc_physical,
    toHlcLogical: r.to_hlc_logical,
    snapshotId: r.snapshot_id,
    operationCount: r.operation_count,
  }));
}
