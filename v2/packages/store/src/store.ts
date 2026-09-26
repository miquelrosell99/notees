/**
 * Store: thin better-sqlite3 wrapper owning the derived-state database.
 *
 *  - apply / applyMany: validate -> idempotency check (applied_envelope) ->
 *    dispatch -> record; applyMany wraps everything in one transaction;
 *  - query helpers: getNode, children, backlinks, search (FTS5 prefix-AND);
 *  - snapshot / restore: SQLite serialize/deserialize. better-sqlite3 has no
 *    deserialize, so restore writes the bytes to a temp file and reopens;
 *  - reset: drop and recreate the schema at the same path.
 *
 * All write timestamps derive from envelope timestamps, never the wall
 * clock, so replayed logs converge to byte-identical databases.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { applyEnvelope, validateEnvelope, type ChangeSummary } from "./appliers.js";
import { buildMatchQuery } from "./search.js";
import { migrate } from "./schema.js";
import type { StoreDatabase } from "./types.js";

type DbInstance = InstanceType<typeof Database>;

export interface NodeRow {
  id: string;
  workspace_id: string;
  node_type: "page" | "block" | "class";
  parent_id: string | null;
  class_ids: string;
  name: string | null;
  content: string;
  icon: string | null;
  color: string | null;
  is_active: number;
  created_at: string | null;
  updated_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  hlc_physical: number;
  hlc_logical: number;
  actor_id: string | null;
}

export interface SearchHit {
  nodeId: string;
}

export class Store {
  private db: DbInstance;
  private readonly path: string;
  private tempDir: string | null = null;

  constructor(path = ":memory:") {
    this.path = path;
    this.db = Store.open(path);
  }

  private static open(path: string): DbInstance {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
    // Foreign keys stay off (v1 precedent): the appliers maintain tree
    // integrity fail-loud, and out-of-order delivery must not hard-fail on
    // a missing parent. Placement invariants live in the CHECK constraints.
    migrate(db as unknown as StoreDatabase);
    return db;
  }

  /** Raw better-sqlite3 handle (tests, migrations, debugging). */
  get database(): DbInstance {
    return this.db;
  }

  /** True when the envelope id was already applied (idempotency). */
  hasApplied(envelopeId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM applied_envelope WHERE id = ?").get(envelopeId) !== undefined
    );
  }

  apply(input: unknown): ChangeSummary {
    return this.applyMany([input])[0]!;
  }

  /** Apply envelopes in one transaction; already-applied ids are skipped. */
  applyMany(inputs: unknown[]): ChangeSummary[] {
    const envelopes = inputs.map((input) => validateEnvelope(input));
    const run = this.db.transaction(() => {
      const summaries: ChangeSummary[] = [];
      for (const env of envelopes) {
        if (this.hasApplied(env.id)) {
          summaries.push({ opType: env.opType, affectedNodeIds: [], ignored: true });
          continue;
        }
        const summary = applyEnvelope(this.db as unknown as StoreDatabase, env);
        const seq = this.recordEnvelope(env.id, env.timestamp);
        this.advanceCursor(env.workspaceId, seq);
        summaries.push(summary);
      }
      return summaries;
    });
    return run();
  }

  private recordEnvelope(envelopeId: string, appliedAt: string): number {
    this.db
      .prepare(
        `INSERT INTO applied_envelope (id, seq, applied_at)
         VALUES (?, COALESCE((SELECT MAX(seq) FROM applied_envelope), 0) + 1, ?)`,
      )
      .run(envelopeId, appliedAt);
    const row = this.db
      .prepare("SELECT seq FROM applied_envelope WHERE id = ?")
      .get(envelopeId) as { seq: number };
    return row.seq;
  }

  private advanceCursor(workspaceId: string, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (workspace_id, cursor_seq, restore_epoch)
         VALUES (?, ?, 0)
         ON CONFLICT(workspace_id) DO UPDATE SET
           cursor_seq = MAX(cursor_seq, excluded.cursor_seq)`,
      )
      .run(workspaceId, seq);
  }

  // --- queries ---------------------------------------------------------------

  getNode(nodeId: string): NodeRow | undefined {
    return this.db.prepare("SELECT * FROM node WHERE id = ?").get(nodeId) as
      | NodeRow
      | undefined;
  }

  /** Direct children in child-order position order. */
  children(parentId: string): NodeRow[] {
    return this.db
      .prepare(
        `SELECT n.* FROM node n
         JOIN node_child_order o ON o.child_id = n.id
         WHERE o.parent_id = ? ORDER BY o.position`,
      )
      .all(parentId) as NodeRow[];
  }

  /** Edges pointing at the node (backlinks), ordered deterministically. */
  backlinks(nodeId: string) {
    return this.db
      .prepare(
        "SELECT * FROM edge WHERE target_id = ? ORDER BY source_id, type, verb, id",
      )
      .all(nodeId);
  }

  /** Edges derived from the node (outgoing references). */
  references(nodeId: string) {
    return this.db
      .prepare("SELECT * FROM edge WHERE source_id = ? ORDER BY type, verb, id")
      .all(nodeId);
  }

  /** FTS5 prefix-AND search over active nodes; ordered by node id. */
  search(query: string, limit = 50): SearchHit[] {
    const match = buildMatchQuery(query);
    if (match === null) return [];
    return this.db
      .prepare(
        `SELECT d.node_id AS nodeId FROM search_index s
         JOIN search_index_docid d ON d.docid = s.rowid
         JOIN node n ON n.id = d.node_id AND n.is_active = 1
         WHERE search_index MATCH ?
         ORDER BY d.node_id LIMIT ?`,
      )
      .all(match, limit) as SearchHit[];
  }

  // --- snapshot / restore / reset ----------------------------------------------

  /** Serialize the whole database to a Buffer. */
  snapshot(): Buffer {
    return this.db.serialize();
  }

  /** Replace the database with a previously snapshotted buffer. */
  restore(bytes: Buffer): void {
    const dir = mkdtempSync(join(tmpdir(), "notees-store-"));
    const file = join(dir, "restored.db");
    writeFileSync(file, bytes);
    this.db.close();
    this.cleanupTemp();
    this.tempDir = dir;
    this.db = new Database(file);
    // The serialized bytes carry their own user_version; just re-apply
    // pragmas for the new connection.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db
      .prepare("UPDATE sync_state SET restore_epoch = restore_epoch + 1")
      .run();
  }

  /** Drop all derived state (schema is recreated empty). */
  reset(): void {
    this.db.close();
    this.cleanupTemp();
    if (this.path !== ":memory:") {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(this.path + suffix, { force: true });
      }
    }
    this.db = Store.open(this.path);
  }

  private cleanupTemp(): void {
    if (this.tempDir !== null) {
      rmSync(this.tempDir, { recursive: true, force: true });
      this.tempDir = null;
    }
  }

  close(): void {
    this.db.close();
    this.cleanupTemp();
  }
}
