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
 *  - query helpers: getNode, children, backlinks, backlinksWithRollup,
 *    search (FTS prefix-AND);
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
import { getEffectiveProperties, type EffectiveProperty } from "./effective.js";
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

  /** Direct class_extends parents of a class, deterministic order. */
  classParentIds(classId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT parent_class_id FROM class_extends WHERE class_id = ? ORDER BY parent_class_id",
        )
        .all(classId) as { parent_class_id: string }[]
    ).map((row) => row.parent_class_id);
  }

  /**
   * Active nodes whose OR-set class membership includes the class (present
   * rows only), in display order. The Class View's members read.
   */
  classMembers(classId: string): NodeRow[] {
    return this.db
      .prepare(
        `SELECT n.* FROM node n
         JOIN class_member_set m ON m.node_id = n.id
         WHERE m.class_id = ? AND m.present = 1 AND n.is_active = 1
         ORDER BY COALESCE(n.name, n.id), n.id`,
      )
      .all(classId) as NodeRow[];
  }

  /** Edges pointing at the node (backlinks), ordered deterministically. */
  backlinks(nodeId: string) {
    return this.db
      .prepare(
        "SELECT * FROM edge WHERE target_id = ? ORDER BY source_id, type, verb, id",
      )
      .all(nodeId);
  }

  /**
   * Backlinks with source-side containment roll-up (`01` §8, traversal at
   * query time — the 00-INDEX fan-out-vs-traversal decision resolved for
   * M1). For target T the list is:
   *
   *  1. **direct** — edges `target_id = T` (any source);
   *  2. **containment** — edges whose SOURCE is strictly inside T's subtree
   *     (recursive `parent_id` walk, distance = depth below T) and whose
   *     TARGET is outside it — an outward link: a block inside France
   *     linking Paris references France by containment. Intra-subtree links
   *     (target also inside T's subtree, T included) are excluded to avoid
   *     self-noise.
   *
   * One row per (source_id, kind) — duplicate mention instances from one
   * source collapse. Each row carries `kind: "direct" | "containment"` and
   * `distance` (0 for direct). Ordered direct first, then containment by
   * distance.
   *
   * Performance: the subtree CTE walks `idx_node_parent (parent_id)` one
   * probe per level (child sets are small); direct edges probe
   * `idx_edge_target (target_id, type)`, containment edges probe
   * `idx_edge_source (source_id, type)` per subtree id, with the
   * outside-subtree test as a NOT IN over the small subtree set; the dedupe
   * is a window over that set.
   *
   * NOTE — badge vs list divergence: `backlinks()` and the materialized
   * `node_stats.backlink_count` (the gutter badge) stay DIRECT (edges
   * targeting T only), so a containment-heavy page legitimately shows a
   * longer linked-references LIST than its badge number.
   */
  backlinksWithRollup(nodeId: string) {
    return this.db
      .prepare(
        `WITH RECURSIVE subtree(id, distance) AS (
           SELECT id, 0 FROM node WHERE id = ?
           UNION ALL
           SELECT n.id, s.distance + 1
           FROM subtree s JOIN node n ON n.parent_id = s.id
         ),
         ranked AS (
           SELECT e.id, e.workspace_id, e.source_id, e.target_id, e.type, e.verb,
                  e.metadata, e.created_at,
                  CASE WHEN e.target_id = ? THEN 'direct' ELSE 'containment' END AS kind,
                  CASE WHEN e.target_id = ? THEN 0 ELSE s.distance END AS distance,
                  ROW_NUMBER() OVER (
                    PARTITION BY e.source_id,
                    CASE WHEN e.target_id = ? THEN 'direct' ELSE 'containment' END
                    ORDER BY e.id
                  ) AS rn
           FROM edge e
           LEFT JOIN subtree s ON s.id = e.source_id
           WHERE e.target_id = ?
              OR (s.distance > 0 AND e.target_id NOT IN (SELECT id FROM subtree))
         )
         SELECT id, workspace_id, source_id, target_id, type, verb, metadata,
                created_at, kind, distance
         FROM ranked
         WHERE rn = 1
         ORDER BY distance, source_id, kind, id`,
      )
      .all(nodeId, nodeId, nodeId, nodeId, nodeId);
  }

  /** Edges derived from the node (outgoing references). */
  references(nodeId: string) {
    return this.db
      .prepare("SELECT * FROM edge WHERE source_id = ? ORDER BY type, verb, id")
      .all(nodeId);
  }

  /**
   * Effective properties of a node (SCHEMA.md "Class properties"): authored
   * property values plus derived class-binding defaults, aggregated across
   * ALL the node's classes with first-class-applied-wins conflict
   * resolution. Pure read — see effective.ts for the merge algorithm.
   */
  getEffectiveProperties(nodeId: string): EffectiveProperty[] {
    return getEffectiveProperties(this.db, nodeId);
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
