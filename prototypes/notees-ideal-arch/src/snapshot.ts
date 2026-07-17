import { Database } from "bun:sqlite";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSchema } from "./db";
import { uuidv7 } from "./uuid";

export interface Snapshot {
  id: string;
  workspaceId: string;
  hlcPhysical: number;
  hlcLogical: number;
  stateHash: string;
  data: Uint8Array;
}

export async function createSnapshot(db: Database, workspaceId: string): Promise<Snapshot> {
  const latestOp = db
    .query("SELECT hlc_physical, hlc_logical FROM operation WHERE workspace_id = ? ORDER BY hlc_physical DESC, hlc_logical DESC LIMIT 1")
    .get(workspaceId) as { hlc_physical: number; hlc_logical: number } | undefined;

  const hlcPhysical = latestOp?.hlc_physical ?? 0;
  const hlcLogical = latestOp?.hlc_logical ?? 0;
  const data = new Uint8Array(db.serialize());
  const stateHash = await sha256(data);
  const id = uuidv7();

  db.run(
    "INSERT INTO snapshot (id, workspace_id, hlc_physical, hlc_logical, state_hash, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, workspaceId, hlcPhysical, hlcLogical, stateHash, data, new Date().toISOString()]
  );

  return { id, workspaceId, hlcPhysical, hlcLogical, stateHash, data };
}

export function latestSnapshot(db: Database, workspaceId: string): Snapshot | null {
  const row = db
    .query("SELECT * FROM snapshot WHERE workspace_id = ? ORDER BY hlc_physical DESC, hlc_logical DESC LIMIT 1")
    .get(workspaceId) as any;
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    hlcPhysical: row.hlc_physical,
    hlcLogical: row.hlc_logical,
    stateHash: row.state_hash,
    data: row.data,
  };
}

export function loadSnapshotData(data: Uint8Array): Database {
  // bun:sqlite can open databases only from file paths, so write the serialized bytes to a temp file.
  const tmpDir = mkdtempSync(join(tmpdir(), "notees-snap-"));
  const tmpPath = join(tmpDir, "state.sqlite");
  writeFileSync(tmpPath, data);
  const db = new Database(tmpPath);
  db.run("PRAGMA journal_mode = MEMORY");
  return db;
}

async function sha256(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data as ArrayBufferView<ArrayBuffer>);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
