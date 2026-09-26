/**
 * Relay envelope log on SQLite (better-sqlite3, one file per server:
 * <dataDir>/relay.db) — the v2 port of v1 app/relay/storage.py.
 *
 *  - envelope table: one row per accepted envelope. `seq` is the
 *    server-assigned ordering authority (INTEGER PRIMARY KEY AUTOINCREMENT);
 *    `id` is UNIQUE so INSERT OR IGNORE makes ingest idempotent (retry-safe).
 *    device_id/client are persisted alongside the spec'd columns so
 *    catch-up can return byte-faithful envelopes.
 *  - restore_epoch: per-workspace counter; a change tells clients to wipe
 *    local state and resync (backup restores bump it — M1 keeps it at 0,
 *    the contract is implemented and tested).
 *  - snapshot rows + blob files under <dataDir>/snapshots/<ws>/<id>.db
 *    (serialized derived-state SQLite bytes from @notees/store).
 *  - compaction_segment rows: prune bookkeeping per WIRE.md POST /compact.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type { Envelope, Hlc } from "@notees/protocol";

type Db = InstanceType<typeof Database>;

const DDL = `
CREATE TABLE IF NOT EXISTS envelope (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    client TEXT,
    physical INTEGER NOT NULL,
    logical INTEGER NOT NULL,
    affected_node_ids TEXT NOT NULL DEFAULT '[]',
    op_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    protocol_version INTEGER NOT NULL,
    timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_envelope_workspace_seq ON envelope (workspace_id, seq);

CREATE TABLE IF NOT EXISTS restore_epoch (
    workspace_id TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS snapshot (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    hlc_physical INTEGER NOT NULL,
    hlc_logical INTEGER NOT NULL,
    up_to_seq INTEGER NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshot_workspace ON snapshot (workspace_id, id);

CREATE TABLE IF NOT EXISTS compaction_segment (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    up_to_hlc_physical INTEGER NOT NULL,
    up_to_hlc_logical INTEGER NOT NULL,
    operation_count INTEGER NOT NULL,
    pruned INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segment_workspace ON compaction_segment (workspace_id, id);

CREATE TABLE IF NOT EXISTS asset (
    asset_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    uploaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_hash ON asset (hash);

CREATE TABLE IF NOT EXISTS asset_ref (
    hash TEXT PRIMARY KEY,
    refs_count INTEGER NOT NULL DEFAULT 0
);
`;

export interface StoredEnvelope {
  seq: number;
  id: string;
  workspace_id: string;
  actor_id: string;
  device_id: string;
  client: string | null;
  physical: number;
  logical: number;
  affected_node_ids: string;
  op_type: string;
  payload: string;
  protocol_version: number;
  timestamp: string;
}

export interface SnapshotRow {
  id: string;
  workspace_id: string;
  hlc_physical: number;
  hlc_logical: number;
  up_to_seq: number;
  size: number;
  created_at: string;
}

export interface IngestResult {
  savedIds: string[];
  /** envelope id → server-assigned seq (saved envelopes only). */
  seqs: Record<string, number>;
}

export interface CatchUpPage {
  envelopes: Envelope[];
  nextAfterSeq: number | null;
  hasMore: boolean;
  totalRemaining: number;
}

export interface RelayStats {
  envelopeCount: number;
  snapshotCount: number;
  compactedOperationCount: number;
  maxHlc: Hlc;
  restoreEpoch: number;
  latestSnapshotHlc: Hlc | null;
}

export interface CompactResult {
  snapshotId: string;
  segmentId: string;
  operationCount: number;
  upToSeq: number;
}

export function storedToEnvelope(row: StoredEnvelope): Envelope {
  const base = {
    id: row.id,
    protocolVersion: row.protocol_version,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    deviceId: row.device_id,
    hlc: { physical: row.physical, logical: row.logical },
    affectedNodeIds: JSON.parse(row.affected_node_ids) as string[],
    opType: row.op_type,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload) as Envelope["payload"],
  };
  return (row.client === null ? base : { ...base, client: row.client }) as Envelope;
}

export class RelayStorage {
  private readonly db: Db;
  private readonly snapshotDir: string;

  constructor(dbPath: string, snapshotDir: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(snapshotDir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(DDL);
    this.snapshotDir = snapshotDir;
  }

  // --- ingest ------------------------------------------------------------------

  /** Idempotent ingest: duplicate ids are silently ignored (WIRE.md POST /batch). */
  ingest(envelopes: Envelope[]): IngestResult {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO envelope
         (id, workspace_id, actor_id, device_id, client, physical, logical,
          affected_node_ids, op_type, payload, protocol_version, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectSeq = this.db.prepare("SELECT seq FROM envelope WHERE id = ?");
    const savedIds: string[] = [];
    const seqs: Record<string, number> = {};
    const run = this.db.transaction(() => {
      for (const env of envelopes) {
        const result = insert.run(
          env.id,
          env.workspaceId,
          env.actorId,
          env.deviceId,
          env.client ?? null,
          env.hlc.physical,
          env.hlc.logical,
          JSON.stringify(env.affectedNodeIds),
          env.opType,
          JSON.stringify(env.payload),
          env.protocolVersion,
          env.timestamp,
        );
        if (result.changes === 0) continue;
        const row = selectSeq.get(env.id) as { seq: number };
        savedIds.push(env.id);
        seqs[env.id] = row.seq;
      }
    });
    run();
    return { savedIds, seqs };
  }

  hasEnvelope(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM envelope WHERE id = ?").get(id) !== undefined;
  }

  // --- catch-up ------------------------------------------------------------------

  /**
   * Envelopes with seq > afterSeq, ascending. `nextAfterSeq` covers the tail
   * of every page (the final page advances HTTP-only clients past the tail);
   * `totalRemaining` counts all rows after afterSeq, this page included.
   */
  catchUp(workspaceId: string, afterSeq: number, limit: number): CatchUpPage {
    const totalRemaining = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM envelope WHERE workspace_id = ? AND seq > ?")
        .get(workspaceId, afterSeq) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        "SELECT * FROM envelope WHERE workspace_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      )
      .all(workspaceId, afterSeq, limit) as unknown as StoredEnvelope[];
    const last = rows[rows.length - 1];
    return {
      envelopes: rows.map(storedToEnvelope),
      nextAfterSeq: last ? last.seq : null,
      hasMore: totalRemaining > rows.length,
      totalRemaining,
    };
  }

  /** All envelopes of a workspace in seq order (hydration replay). */
  allEnvelopes(workspaceId: string): Envelope[] {
    const rows = this.db
      .prepare("SELECT * FROM envelope WHERE workspace_id = ? ORDER BY seq ASC")
      .all(workspaceId) as unknown as StoredEnvelope[];
    return rows.map(storedToEnvelope);
  }

  latestSeq(workspaceId: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS seq FROM envelope WHERE workspace_id = ?")
      .get(workspaceId) as { seq: number | null };
    return row.seq ?? 0;
  }

  envelopeCount(workspaceId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM envelope WHERE workspace_id = ?")
        .get(workspaceId) as { n: number }
    ).n;
  }

  /** Highest HLC observed in the workspace log. */
  maxHlc(workspaceId: string): Hlc {
    const row = this.db
      .prepare(
        `SELECT physical, logical FROM envelope WHERE workspace_id = ?
         ORDER BY physical DESC, logical DESC LIMIT 1`,
      )
      .get(workspaceId) as { physical: number; logical: number } | undefined;
    return row ?? { physical: 0, logical: 0 };
  }

  /** Highest HLC observed across the whole log (server clock seeding). */
  globalMaxHlc(): Hlc {
    const row = this.db
      .prepare("SELECT physical, logical FROM envelope ORDER BY physical DESC, logical DESC LIMIT 1")
      .get() as { physical: number; logical: number } | undefined;
    return row ?? { physical: 0, logical: 0 };
  }

  // --- restore epoch --------------------------------------------------------------

  restoreEpoch(workspaceId: string): number {
    const row = this.db
      .prepare("SELECT epoch FROM restore_epoch WHERE workspace_id = ?")
      .get(workspaceId) as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  }

  /** Simulated backup restore: bumps the epoch (clients wipe + resync). */
  bumpRestoreEpoch(workspaceId: string): number {
    this.db
      .prepare(
        `INSERT INTO restore_epoch (workspace_id, epoch) VALUES (?, 1)
         ON CONFLICT(workspace_id) DO UPDATE SET epoch = epoch + 1`,
      )
      .run(workspaceId);
    return this.restoreEpoch(workspaceId);
  }

  // --- snapshots --------------------------------------------------------------

  private snapshotPath(snapshotId: string): string {
    return join(this.snapshotDir, `${snapshotId}.db`);
  }

  saveSnapshot(workspaceId: string, snapshotId: string, hlc: Hlc, upToSeq: number, bytes: Buffer): void {
    const path = this.snapshotPath(snapshotId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    this.db
      .prepare(
        `INSERT INTO snapshot (id, workspace_id, hlc_physical, hlc_logical, up_to_seq, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(snapshotId, workspaceId, hlc.physical, hlc.logical, upToSeq, bytes.length, new Date().toISOString());
  }

  latestSnapshot(workspaceId: string): SnapshotRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM snapshot WHERE workspace_id = ? ORDER BY up_to_seq DESC, id DESC LIMIT 1`,
      )
      .get(workspaceId) as SnapshotRow | undefined;
    return row ?? null;
  }

  snapshotById(snapshotId: string): SnapshotRow | null {
    const row = this.db
      .prepare("SELECT * FROM snapshot WHERE id = ?")
      .get(snapshotId) as SnapshotRow | undefined;
    return row ?? null;
  }

  readSnapshotData(snapshotId: string): Buffer | null {
    const path = this.snapshotPath(snapshotId);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }

  snapshotCount(workspaceId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM snapshot WHERE workspace_id = ?")
        .get(workspaceId) as { n: number }
    ).n;
  }

  // --- compact -------------------------------------------------------------------

  /**
   * Snapshot the derived state up to an HLC and optionally prune the covered
   * envelopes from the log (prune requires the snapshot bytes, WIRE.md).
   * Envelopes are covered when their HLC <= upToHlc.
   */
  compact(
    workspaceId: string,
    segmentId: string,
    snapshotId: string,
    upToHlc: Hlc,
    prune: boolean,
    data: Buffer,
  ): CompactResult {
    const covered = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS maxSeq FROM envelope
         WHERE workspace_id = ? AND (physical < ? OR (physical = ? AND logical <= ?))`,
      )
      .get(workspaceId, upToHlc.physical, upToHlc.physical, upToHlc.logical) as {
      n: number;
      maxSeq: number;
    };
    const run = this.db.transaction(() => {
      this.saveSnapshot(workspaceId, snapshotId, upToHlc, covered.maxSeq, data);
      this.db
        .prepare(
          `INSERT INTO compaction_segment
             (id, workspace_id, up_to_hlc_physical, up_to_hlc_logical, operation_count, pruned, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          segmentId,
          workspaceId,
          upToHlc.physical,
          upToHlc.logical,
          covered.n,
          prune ? 1 : 0,
          new Date().toISOString(),
        );
      if (prune) {
        this.db
          .prepare(
            `DELETE FROM envelope
             WHERE workspace_id = ? AND (physical < ? OR (physical = ? AND logical <= ?))`,
          )
          .run(workspaceId, upToHlc.physical, upToHlc.physical, upToHlc.logical);
      }
    });
    run();
    return { snapshotId, segmentId, operationCount: covered.n, upToSeq: covered.maxSeq };
  }

  // --- stats ----------------------------------------------------------------------

  stats(workspaceId: string): RelayStats {
    const max = this.maxHlc(workspaceId);
    const snap = this.latestSnapshot(workspaceId);
    const compacted = (
      this.db
        .prepare(
          "SELECT COALESCE(SUM(operation_count), 0) AS n FROM compaction_segment WHERE workspace_id = ?",
        )
        .get(workspaceId) as { n: number }
    ).n;
    return {
      envelopeCount: this.envelopeCount(workspaceId),
      snapshotCount: this.snapshotCount(workspaceId),
      compactedOperationCount: compacted,
      maxHlc: max,
      restoreEpoch: this.restoreEpoch(workspaceId),
      latestSnapshotHlc: snap ? { physical: snap.hlc_physical, logical: snap.hlc_logical } : null,
    };
  }

  // --- asset index (CAS bookkeeping) -------------------------------------------------

  recordAsset(asset: {
    assetId: string;
    workspaceId: string;
    hash: string;
    mimeType: string;
    size: number;
    originalName: string;
    uploadedAt: string;
  }): void {
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO asset (asset_id, workspace_id, hash, mime_type, size, original_name, uploaded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          asset.assetId,
          asset.workspaceId,
          asset.hash,
          asset.mimeType,
          asset.size,
          asset.originalName,
          asset.uploadedAt,
        );
      this.db
        .prepare(
          `INSERT INTO asset_ref (hash, refs_count) VALUES (?, 1)
           ON CONFLICT(hash) DO UPDATE SET refs_count = refs_count + 1`,
        )
        .run(asset.hash);
    });
    run();
  }

  assetById(assetId: string):
    | { assetId: string; workspaceId: string; hash: string; mimeType: string; size: number; originalName: string }
    | null {
    const row = this.db
      .prepare("SELECT * FROM asset WHERE asset_id = ?")
      .get(assetId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      assetId: row.asset_id as string,
      workspaceId: row.workspace_id as string,
      hash: row.hash as string,
      mimeType: row.mime_type as string,
      size: row.size as number,
      originalName: row.original_name as string,
    };
  }

  assetRefs(hash: string): number {
    const row = this.db.prepare("SELECT refs_count FROM asset_ref WHERE hash = ?").get(hash) as
      | { refs_count: number }
      | undefined;
    return row?.refs_count ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
