/**
 * Store: thin SQLite wrapper owning the derived-state database.
 *
 * Driver-agnostic: operates on any SqliteDB connection (see `./db.ts`)
 * injected as a StoreBackend — better-sqlite3 for server/CLI
 * (`Store.openFile`), sql.js for browser/WASM (`Store.open(sqljsBackend(...))`
 * from `./adapters/sqljs.js`). The backend re-opens connections on
 * restore/reset, which is adapter-specific (temp file vs exported bytes).
 *
 *  - apply / applyMany: validate -> idempotency check (applied_envelope) ->
 *    dispatch -> record; applyMany wraps everything in one transaction;
 *  - query helpers: getNode, children, backlinks, search (FTS prefix-AND);
 *  - snapshot / restore: full-database bytes; the bytes carry their own
 *    user_version, so restore only re-applies connection-level setup;
 *  - reset: drop and recreate the schema at the same storage location.
 *
 * All write timestamps derive from envelope timestamps, never the wall
 * clock, so replayed logs converge to byte-identical databases.
 */

import { applyEnvelope, validateEnvelope, type ChangeSummary } from "./appliers.js";
import type { SqliteDB, StoreBackend } from "./db.js";
import { betterSqlite3Backend } from "./adapters/better-sqlite3.js";
import { buildMatchQuery } from "./search.js";
import { migrate } from "./schema.js";

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
  private db: SqliteDB;
  private readonly backend: StoreBackend;

  /**
   * Low-level opening: wrap a backend's connections. A bare path string is
   * accepted for back-compat (legacy `new Store(path)` shorthand for the
   * better-sqlite3 file backend); prefer the `openFile`/`open` factories.
   */
  constructor(backend: StoreBackend);
  constructor(path?: string);
  constructor(backendOrPath: StoreBackend | string = ":memory:") {
    this.backend =
      typeof backendOrPath === "string"
        ? betterSqlite3Backend(backendOrPath)
        : backendOrPath;
    this.db = this.backend.open();
    migrate(this.db, this.backend.ftsModule);
  }

  /** Open a store over an explicit backend (e.g. the sql.js adapter). */
  static open(backend: StoreBackend): Store {
    return new Store(backend);
  }

  /** Open (or create) a file-backed store via better-sqlite3 (server/CLI). */
  static openFile(path = ":memory:"): Store {
    return new Store(betterSqlite3Backend(path));
  }

  /** Raw adapter handle (tests, migrations, debugging). */
  get database(): SqliteDB {
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
        const summary = applyEnvelope(this.db, env);
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

  /** FTS prefix-AND search over active nodes; ordered by node id. */
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

  /** Serialize the whole database to bytes. */
  snapshot(): Uint8Array {
    if (this.db.serialize === undefined) {
      throw new Error("store: this backend does not support serialize()");
    }
    return this.db.serialize();
  }

  /** Replace the database with a previously snapshotted byte stream. */
  restore(bytes: Uint8Array): void {
    const next = this.backend.restore(bytes);
    this.db.close?.();
    this.db = next;
    this.db
      .prepare("UPDATE sync_state SET restore_epoch = restore_epoch + 1")
      .run();
  }

  /** Drop all derived state (schema is recreated empty). */
  reset(): void {
    this.db.close?.();
    this.db = this.backend.reset();
    migrate(this.db, this.backend.ftsModule);
  }

  close(): void {
    this.db.close?.();
  }
}
