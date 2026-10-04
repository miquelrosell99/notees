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

import type { Envelope, WorkspaceFeature } from "@notees/protocol";
import { managedClassIds } from "@notees/domain";

import { applyEnvelope, validateEnvelope, type ChangeSummary } from "./appliers.js";
import type { SqliteDB, StoreBackend } from "./db.js";
import { betterSqlite3Backend } from "./adapters/better-sqlite3.js";
import { getEffectiveProperties, type EffectiveProperty } from "./effective.js";
import { visiblePropertyValueRows } from "./property-values.js";
import {
  dropSearchIndex,
  isSearchIndexQueryable,
  reindexAllSearch,
  searchNodes,
  searchNodesPage,
  searchSnippet,
  type SearchSnippet,
} from "./search.js";
import { MoveGuardError } from "./errors.js";
import { migrate, schemaSql } from "./schema.js";

export interface NodeRow {
  id: string;
  workspace_id: string;
  /** Class identity bit (Revision 11): 1 = class node (always a root). */
  is_class: number;
  /** Render bit for parented non-class nodes: 1 = the parent's
   * main-children zone + document chrome when zoomed; 0 = inline body +
   * block chrome. Unread for parentless nodes and classes. */
  present_as_main: number;
  parent_id: string | null;
  class_ids: string;
  tag_ids: string;
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

  // --- durable local op log -----------------------------------------------------
  //
  // Every locally-authored envelope is recorded here until the server
  // acknowledges it (the engine's outbox is memory-only; this table is what
  // makes offline work survive reloads and lets a device push its local-only
  // data on the first connection after logging in).

  recordLocalEnvelope(envelope: { id: string } & Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO local_op_log (id, envelope, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(envelope.id, JSON.stringify(envelope), Date.now());
  }

  markLocalEnvelopesPushed(ids: string[]): void {
    if (ids.length === 0) return;
    const mark = this.db.prepare("UPDATE local_op_log SET pushed_at = ? WHERE id = ?");
    const now = Date.now();
    const run = this.db.transaction(() => {
      for (const id of ids) mark.run(now, id);
    });
    run();
  }

  /** Locally-authored envelopes not yet acknowledged by the server. */
  unpushedEnvelopes(): unknown[] {
    const rows = this.db
      .prepare(
        "SELECT envelope FROM local_op_log WHERE pushed_at IS NULL ORDER BY created_at ASC",
      )
      .all() as { envelope: string }[];
    return rows.map((row) => JSON.parse(row.envelope) as unknown);
  }

  /** Retention: drop acknowledged rows (called after catch-up converges). */
  prunePushedLocalEnvelopes(): void {
    this.db.prepare("DELETE FROM local_op_log WHERE pushed_at IS NOT NULL").run();
  }

  /**
   * Apply one envelope — the LOCAL authoring path. Fails loud (never
   * quarantines): a guard violation throws, per the fail-loud law.
   */
  apply(input: unknown): ChangeSummary {
    return this.applyMany([input])[0]!;
  }

  /**
   * Apply envelopes in one transaction; already-applied ids are skipped.
   * With `quarantineMoveGuards` (the REMOTE replay path used by the sync
   * engine) an op failing the move guard is quarantined — recorded in
   * `quarantined_envelope`, marked processed so the cursor advances — so one
   * poison op in the log history (e.g. a pre-Revision-11 class-parenting
   * move) never bricks every fresh replay. The default (local authoring,
   * tests) stays fail-loud; validation errors always throw.
   */
  applyMany(
    inputs: unknown[],
    options: { quarantineMoveGuards?: boolean } = {},
  ): ChangeSummary[] {
    const quarantineGuards = options.quarantineMoveGuards === true;
    const envelopes = inputs.map((input) => validateEnvelope(input));
    const run = this.db.transaction(() => {
      const summaries: ChangeSummary[] = [];
      for (const env of envelopes) {
        if (this.hasApplied(env.id)) {
          summaries.push({ opType: env.opType, affectedNodeIds: [], ignored: true });
          continue;
        }
        try {
          const summary = applyEnvelope(this.db, env);
          const seq = this.recordEnvelope(env.id, env.timestamp);
          this.advanceCursor(env.workspaceId, seq);
          summaries.push(summary);
        } catch (err) {
          // Quarantine is for HISTORICAL GUARD violations only (ops the log
          // carries from an older model era — e.g. the pre-Revision-11
          // class-parenting move — which every fresh replay must survive).
          // Validation errors (PropertyValueShapeError et al.) still throw:
          // data-quality failures must stay loud.
          if (!(err instanceof MoveGuardError) || !quarantineGuards) throw err;
          const message = err instanceof Error ? err.message : String(err);
          this.quarantineEnvelope(env, message);
          const seq = this.recordEnvelope(env.id, env.timestamp);
          this.advanceCursor(env.workspaceId, seq);
          summaries.push({
            opType: env.opType,
            affectedNodeIds: [],
            ignored: false,
            quarantined: true,
            error: message,
          });
        }
      }
      return summaries;
    });
    return run();
  }

  /** Quarantined remote envelopes (one poison op must never brick replay). */
  quarantinedEnvelopes(): Array<{
    id: string;
    workspaceId: string;
    opType: string;
    error: string;
    payload: string;
    quarantinedAt: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, workspace_id AS workspaceId, op_type AS opType, error,
                payload, quarantined_at AS quarantinedAt
         FROM quarantined_envelope ORDER BY quarantined_at, id`,
      )
      .all() as Array<{
      id: string;
      workspaceId: string;
      opType: string;
      error: string;
      payload: string;
      quarantinedAt: string;
    }>;
  }

  private quarantineEnvelope(env: Envelope, error: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO quarantined_envelope
           (id, workspace_id, op_type, error, payload, quarantined_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(env.id, env.workspaceId, env.opType, error, JSON.stringify(env.payload), env.timestamp);
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

  /**
   * Workspace root pages: active non-class nodes with no parent, in display
   * order (same ORDER BY as the clients' page lists). Classes are excluded
   * even though they are always roots — they are listed separately; parented
   * nodes (inline blocks, main children) are excluded regardless of the
   * render bit. This is the workspace-zip enumerator (top-level pages, then
   * walk descendants) and the shell's top-level page lists.
   */
  roots(workspaceId: string): NodeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM node
         WHERE workspace_id = ? AND is_class = 0 AND parent_id IS NULL AND is_active = 1
         ORDER BY COALESCE(name, id), id`,
      )
      .all(workspaceId) as NodeRow[];
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

  /** Classes whose extends closure contains classId (direct + indirect
   * subclasses), deterministic order — the Class View's "Extended by" read. */
  classChildIds(classId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT class_id FROM class_hierarchy WHERE ancestor_id = ? AND class_id != ? ORDER BY class_id",
        )
        .all(classId, classId) as { class_id: string }[]
    ).map((row) => row.class_id);
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
         ORDER BY COALESCE((SELECT name FROM class WHERE id = n.id), n.id), n.id`,
      )
      .all(classId) as NodeRow[];
  }

  /**
   * The members count for section badges — the same membership projection
   * as classMembers as a COUNT (indexed; the badge renders eagerly like
   * the child-pages/backlinks counts).
   */
  classMembersCount(classId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM node n
         JOIN class_member_set m ON m.node_id = n.id
         WHERE m.class_id = ? AND m.present = 1 AND n.is_active = 1`,
      )
      .get(classId) as { count: number };
    return row.count;
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

  /**
   * Nodes carrying an authored value for the property schema (§34.32 PG12 —
   * the PropertyReferencesSection population): every ACTIVE node with at
   * least one property_value row for the schema, each row's slots alongside.
   * Ordered by the same display key as classMembers (COALESCE(name, id), id)
   * so the listing is deterministic. Authored rows only — derived defaults
   * never materialize (SCHEMA.md), so an unvalued binding never lists.
   */
  propertyValueCarriers(
    schemaId: string,
  ): Array<{
    node: NodeRow;
    slots: Array<{ idx: number; value: unknown; metadata: Record<string, unknown> | null }>;
  }> {
    // PG5: the population read rides the same visible-set derivation as the
    // effective model — a tombstoned element never lists.
    type CarrierRow = {
      node: NodeRow;
      pv_idx: number;
      pv_value: string;
      pv_metadata: string | null;
    };
    const rows: CarrierRow[] = visiblePropertyValueRows(this.db)
      .filter((row) => row.property_schema_id === schemaId)
      .map((row) => {
        const node = this.db
          .prepare("SELECT * FROM node WHERE id = ?")
          .get(row.node_id) as NodeRow | undefined;
        return node === undefined || node.is_active !== 1
          ? null
          : { node, pv_idx: row.idx, pv_value: row.value, pv_metadata: row.metadata };
      })
      .filter((row): row is CarrierRow => row !== null);
    const displayKeyOf = (node: NodeRow): string => {
      const className = (
        this.db.prepare("SELECT name FROM class WHERE id = ?").get(node.id) as
          | { name: string }
          | undefined
      )?.name;
      return className ?? node.id;
    };
    rows.sort(
      (a, b) =>
        displayKeyOf(a.node).localeCompare(displayKeyOf(b.node)) ||
        a.node.id.localeCompare(b.node.id) ||
        a.pv_idx - b.pv_idx,
    );
    const byNode = new Map<string, { node: NodeRow; slots: Array<{ idx: number; value: unknown; metadata: Record<string, unknown> | null }> }>();
    for (const row of rows) {
      const { pv_idx, pv_value, pv_metadata, node } = row;
      let entry = byNode.get(node.id);
      if (entry === undefined) {
        entry = { node, slots: [] };
        byNode.set(node.id, entry);
      }
      entry.slots.push({
        idx: pv_idx,
        value: JSON.parse(pv_value) as unknown,
        metadata: pv_metadata !== null ? (JSON.parse(pv_metadata) as Record<string, unknown>) : null,
      });
    }
    return [...byNode.values()];
  }

  /**
   * Scalar (plain-string) values of one schema on one node, slot order —
   * the alias read (§34.32 PG10): alias values are name-equivalents in
   * search resolution, and this is the cheap per-node read those paths
   * use. Carrier references ({nodeId} — node-backed rich text) are not
   * names and stay out; null/non-string slots are skipped.
   */
  scalarPropertyValues(nodeId: string, schemaId: string): string[] {
    const values: string[] = [];
    for (const row of visiblePropertyValueRows(this.db, nodeId)) {
      if (row.property_schema_id !== schemaId) continue;
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (typeof parsed === "string" && parsed.length > 0) values.push(parsed);
      } catch {
        // Unparseable rows are not names — skip (derived state is trusted).
      }
    }
    return values;
  }

  /**
   * FTS prefix-AND search over active nodes (§34.30 M2): relevance-ranked —
   * FTS5 orders by the hidden rank column, FTS4 by matchinfo hit count
   * (its module has no rank column) — with an updated_at recency tiebreak
   * and node id for full determinism.
   */
  search(query: string, limit = 50): SearchHit[] {
    return searchNodes(this.db, query, limit);
  }

  /**
   * Cursor-paginated ranked search (§34.30 C5): same deterministic order as
   * `search`, one page at a time. `cursor` is the opaque value the previous
   * page returned (`null`/absent for the first page); `nextCursor` is null
   * when the match set is exhausted. A garbage cursor throws (fail loud).
   */
  searchPage(
    query: string,
    opts?: { limit?: number | undefined; cursor?: string | null | undefined },
  ): { hits: SearchHit[]; nextCursor: string | null } {
    return searchNodesPage(this.db, query, opts?.limit ?? 50, opts?.cursor ?? null);
  }

  /**
   * Snippet around the densest query-term cluster in one node's indexed
   * plaintext (§34.30 M3) — null when the node is unknown or unmatched.
   */
  getSearchSnippet(
    nodeId: string,
    query: string,
    opts?: { maxTokens?: number; ellipsis?: string },
  ): SearchSnippet | null {
    return searchSnippet(this.db, nodeId, query, opts);
  }

  // --- workspace features (§34.35) -------------------------------------------

  /**
   * The winning feature-toggle row, or null when the workspace never
   * toggled it. Callers read through `isFeatureEnabled` for the F2 default
   * (absent row = enabled).
   */
  getFeatureRow(
    workspaceId: string,
    feature: string,
  ): { feature: string; enabled: boolean } | undefined {
    const row = this.db
      .prepare(
        "SELECT feature, enabled FROM workspace_feature WHERE workspace_id = ? AND feature = ?",
      )
      .get(workspaceId, feature) as { feature: string; enabled: number } | undefined;
    return row === undefined ? undefined : { feature: row.feature, enabled: row.enabled === 1 };
  }

  /** F2 default semantics: an absent row means ENABLED (the empty table is all-ON). */
  isFeatureEnabled(workspaceId: string, feature: string): boolean {
    return this.getFeatureRow(workspaceId, feature)?.enabled ?? true;
  }

  /** All toggle rows the workspace has (untoggled features are absent, not listed). */
  listFeatureRows(workspaceId: string): Array<{ feature: string; enabled: boolean }> {
    const rows = this.db
      .prepare(
        "SELECT feature, enabled FROM workspace_feature WHERE workspace_id = ? ORDER BY feature",
      )
      .all(workspaceId) as Array<{ feature: string; enabled: number }>;
    return rows.map((row) => ({ feature: row.feature, enabled: row.enabled === 1 }));
  }

  /**
   * Active instance count across a feature's managed classes (F3 disable
   * confirmation — "N existing objects keep their data"): distinct active
   * non-class nodes with a present membership row in any managed class.
   */
  featureInstanceCount(workspaceId: string, feature: WorkspaceFeature): number {
    const ids = managedClassIds(feature);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT m.node_id) AS n
         FROM class_member_set m
         JOIN node node ON node.id = m.node_id
         WHERE m.class_id IN (${placeholders}) AND m.present = 1
           AND node.workspace_id = ? AND node.is_active = 1 AND node.is_class = 0`,
      )
      .get(...ids, workspaceId) as { n: number };
    return row.n;
  }

  // --- snapshot / restore / reset ----------------------------------------------

  /** Serialize the whole database to bytes. */
  snapshot(): Uint8Array {
    if (this.db.serialize === undefined) {
      throw new Error("store: this backend does not support serialize()");
    }
    return this.db.serialize();
  }

  /**
   * Replace the database with a previously snapshotted byte stream.
   *
   * Cross-backend snapshots: a server-side snapshot's search_index is FTS5,
   * which an FTS4-only build (stock sql.js) can neither query nor maintain.
   * The index is derived state, so when the probe query fails (missing
   * module, or a missing/corrupt table), the table is dropped module-free,
   * the connection is re-opened from freshly exported bytes (sqlite_master
   * surgery leaves the schema cache stale), and the schema is re-applied with
   * the LOCAL fts module before reindexing from node name + content.
   * Deterministic: wipe + replay converges to the same index regardless of
   * which backend produced the snapshot.
   */
  restore(bytes: Uint8Array): void {
    let next = this.backend.restore(bytes);
    // The snapshot may carry an OLDER schema than this build (restore swaps
    // the whole database; nothing migrates it afterwards). Bump to the
    // current version — migrate() is version-gated and idempotent, and no-ops
    // when the bytes are already current.
    migrate(next, this.backend.ftsModule);
    if (!isSearchIndexQueryable(next)) {
      dropSearchIndex(next);
      if (next.serialize === undefined) {
        next.close?.();
        throw new Error("store: search_index rebuild requires a serializable backend");
      }
      const repaired = next.serialize();
      next.close?.();
      next = this.backend.restore(repaired);
      // Idempotent DDL (not migrate(): the carried user_version already
      // matches, but the rebuilt connection is missing the index tables).
      next.exec(schemaSql(this.backend.ftsModule));
      reindexAllSearch(next);
    }
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
