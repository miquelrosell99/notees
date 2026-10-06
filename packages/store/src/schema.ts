/**
 * Derived-state SQLite schema for Notees (better-sqlite3, synchronous).
 *
 * Port of `app/core/derived/schema.py` + `frontend/src/core/db/schema.ts`
 * (client schema v22), adapted to the current model (SCHEMA.md):
 *  - the Revision-11 render-state model: `node.is_class` (identity marker,
 *    classes are always roots) + `node.present_as_main` (render bit for
 *    parented non-class nodes) replace the retired node_type enumeration;
 *    the single placement CHECK (`is_class = 0 OR parent_id IS NULL`) keeps
 *    illegal states unrepresentable;
 *  - FTS5 replaces the old FTS4 (same node_id -> docid map pattern); the stock
 *    sql.js WASM build lacks FTS5, so sql.js-backed stores build the same
 *    index with FTS4 (`schemaSql("fts4")`, selected by the backend's
 *    declared `ftsModule` — identical MATCH/prefix syntax);
 *  - `class_member_set` / `collection_member` are OR-Sets whose present rows
 *    the appliers project into `node.class_ids` / membership state;
 *  - `applied_envelope` gives op-log idempotency: replayed envelope ids are
 *    skipped, so wipe -> replay converges to identical state.
 *
 * All JSON-like columns are TEXT; no AUTOINCREMENT anywhere (deterministic
 * rebuilds; `applied_envelope.seq` is assigned from MAX(seq)+1).
 */

import type { SqliteDB } from "./db.js";

export const SCHEMA_VERSION = 15;

/**
 * The render-path list-reads index: composite for the
 * listClasses/listPages/roots WHERE (workspace_id, is_class, is_active) +
 * ORDER BY COALESCE(name, id), id — the profiled full-scan+sort per render
 * burst. Kept OUT of the canonical schema DDL on purpose: migrate()'s
 * canonical exec runs before the rebuild ladder, where pre-v8 node tables
 * don't have is_class/present_as_main yet. Version-gated ladder step +
 * explicit re-assert on the snapshot-repair path instead (single source here).
 */
export const LIST_READS_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_node_list_reads ON node (workspace_id, is_class, is_active, name, id);";

/** FTS module for the search_index virtual table (backend capability). */
export type FtsModule = "fts5" | "fts4";

const SEARCH_INDEX_DDL_FTS5 = `CREATE VIRTUAL TABLE IF NOT EXISTS search_index
    USING fts5(content, tokenize = 'unicode61');`;

/**
 * Canonical DDL (FTS5). `schemaSql("fts4")` builds the same schema for
 * backends without FTS5 (stock sql.js); everything else is identical.
 */
export function schemaSql(ftsModule: FtsModule = "fts5"): string {
  return ftsModule === "fts5" ? SCHEMA_SQL : SCHEMA_SQL_FTS4;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS node (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    -- Revision-11 render-state model (replaces the node_type enumeration):
    -- is_class is the ONLY identity marker — classes are always roots;
    -- present_as_main is the render bit read by the third cascade branch
    -- for parented non-class nodes: 1 = the parent's main-children zone +
    -- document chrome when zoomed, 0 = inline body + block chrome. The bit
    -- is unread for parentless nodes (document chrome by the second branch)
    -- and for classes (ClassView by the first branch).
    is_class INTEGER NOT NULL DEFAULT 0,
    present_as_main INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT REFERENCES node(id),
    class_ids TEXT NOT NULL DEFAULT '[]',
    -- User-defined class ORDER (class.reorder, LWW-by-arrival); the
    -- effective class_ids = ordered members first, then unlisted members
    -- sorted by id (recomputeClassIds).
    class_order TEXT NOT NULL DEFAULT '[]',
    tag_ids TEXT NOT NULL DEFAULT '[]',
    name TEXT,
    content TEXT NOT NULL DEFAULT '[]',
    icon TEXT,
    color TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT,
    updated_at TEXT,
    created_by TEXT,
    updated_by TEXT,
    -- Winning-op causality for row-level last-write-wins merges.
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    -- Classes are always roots; every other node may sit anywhere in the
    -- tree, parentless nodes included (they render with document chrome).
    CHECK (is_class = 0 OR parent_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_node_workspace ON node (workspace_id);
CREATE INDEX IF NOT EXISTS idx_node_parent ON node (parent_id);

CREATE TABLE IF NOT EXISTS node_child_order (
    parent_id TEXT NOT NULL,
    child_id TEXT NOT NULL,
    position TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id)
);

CREATE INDEX IF NOT EXISTS idx_node_child_order_parent
    ON node_child_order (parent_id);

-- OR-Set of class assignments; the applier recomputes node.class_ids from
-- the present rows (add-wins, LWW per (node_id, class_id) by (hlc, actor)).
CREATE TABLE IF NOT EXISTS class_member_set (
    node_id TEXT NOT NULL,
    class_id TEXT NOT NULL,
    present INTEGER NOT NULL,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    PRIMARY KEY (node_id, class_id)
);

CREATE INDEX IF NOT EXISTS idx_class_member_set_class
    ON class_member_set (class_id);

-- OR-Set of tag assignments (tags are pages assigned to a page — the same
-- membership semantics as classes, own table, no role overlap).
CREATE TABLE IF NOT EXISTS tag_member_set (
    node_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    present INTEGER NOT NULL,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    PRIMARY KEY (node_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_tag_member_set_tag
    ON tag_member_set (tag_id);

-- Direct extends edges (m2m: a class may have MULTIPLE parents, per the
-- designed model). class.setExtends replaces
-- the class's full row set (delete + insert). Rows carry no order — diamond
-- resolution (own binding → shortest extends-path → earliest HLC) happens
-- at read time in the bindings read model.
CREATE TABLE IF NOT EXISTS class_extends (
    class_id TEXT NOT NULL,
    parent_class_id TEXT NOT NULL,
    PRIMARY KEY (class_id, parent_class_id)
);

CREATE INDEX IF NOT EXISTS idx_class_extends_parent
    ON class_extends (parent_class_id);

-- Transitive closure of class extends (m2m, many rows per class_id);
-- includes the self-row (class_id, class_id). Applier-maintained.
CREATE TABLE IF NOT EXISTS class_hierarchy (
    class_id TEXT NOT NULL,
    ancestor_id TEXT NOT NULL,
    PRIMARY KEY (class_id, ancestor_id)
);

CREATE INDEX IF NOT EXISTS idx_class_hierarchy_ancestor
    ON class_hierarchy (ancestor_id);

-- Class registry rows (name/icon/color/description), keyed by the class
-- node id. The node row (is_class = 1) is the structural authority;
-- this table carries class-only configuration (description).
CREATE TABLE IF NOT EXISTS class (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_class_workspace ON class (workspace_id);

CREATE TABLE IF NOT EXISTS property_schema (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    multi INTEGER NOT NULL DEFAULT 0,
    scope TEXT NOT NULL DEFAULT 'global',
    options TEXT NOT NULL DEFAULT '[]',
    target_class_filter TEXT,
    -- SCHEMA.md "Dates": finest granularity a date value may claim
    -- (year|month|day; NULL = day default) and, for node-typed schemas,
    -- whether values may carry date qualifiers (metadata startDate/endDate).
    date_precision TEXT,
    date_qualified INTEGER,
    -- SCHEMA.md "Number formats": display-only formatting for number
    -- schemas (values stay exact; these shape render only). number_pad:
    -- zero-pad the integer part to N digits; number_decimals: digits after
    -- the point; number_rounding: round|floor|ceil|truncate.
    number_pad INTEGER,
    number_decimals INTEGER,
    number_rounding TEXT,
    -- The render contracts are PROPERTY-level (owner review
    -- 2026-10-05) — display (panel|bullet|inline; NULL = panel) and the
    -- readonly/hide-when-empty tri-state flags, wherever the property
    -- appears (class-bound or not). ('required' deliberately stays on the
    -- class binding — a property may be mandatory for one class, optional
    -- for another.)
    display TEXT,
    readonly INTEGER,
    hide_when_empty INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_property_schema_workspace
    ON property_schema (workspace_id);

-- Class -> property binding rows (sequence, default), authored by
-- class.property.set / class.property.unset (SCHEMA.md "Class properties").
-- Row-level LWW by (hlc, actor): the winning write's causality is stored on
-- the row, so a stale set replayed after a newer one is dropped. Defaults
-- here are configuration only — the applier never writes property_value rows
-- for them; the effective-values read model derives them at query time.
-- (owner review 2026-10-05): the row carries ONLY the genuinely
-- per-class mechanics (sequence, required, default_value, active). The
-- render contracts (readonly/hide_when_empty/display) are PROPERTY-level
-- and live on property_schema.
-- 'active' (PC4): the soft-unbind flag — an inactive row stops contributing
-- to the effective read (no default, no sequence); authored values survive.
CREATE TABLE IF NOT EXISTS class_property (
    class_id TEXT NOT NULL,
    property_schema_id TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,
    required INTEGER,
    default_value TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    PRIMARY KEY (class_id, property_schema_id)
);

CREATE INDEX IF NOT EXISTS idx_class_property_class
    ON class_property (class_id);

-- Authored property values — the LIVE visible rows only (the applier deletes
-- a row when its element's OR-Set remove wins). The row id IS the element id
-- (PG5): writer-minted UUIDv7 for element adds, the deterministic composite
-- 'node:schema:idx' for single-value slots and legacy positional writes. The
-- pre-v11 UNIQUE(node_id, property_schema_id, idx) is GONE: per-element
-- identity means concurrent adds at the same idx are DISTINCT elements and
-- both stay visible — 'idx' is only a per-element order hint (readers order
-- by (idx, element id); gaps never heal — PB4 tolerance).
CREATE TABLE IF NOT EXISTS property_value (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    property_schema_id TEXT NOT NULL,
    value TEXT NOT NULL,
    idx INTEGER NOT NULL DEFAULT 0,
    metadata TEXT,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_property_value_node ON property_value (node_id);

-- PG5 OR-Set element tombstones: one row per removed element, carrying the
-- winning remove's causality. An element is VISIBLE iff its live row exists
-- and no tombstone carries a strictly-newer (hlc) remove (add-wins: on equal
-- HLC the add wins regardless of actor). Removes upsert with the
-- strictly-greater full (hlc, actor) tuple, mirroring class.unassign.
CREATE TABLE IF NOT EXISTS property_value_element_tombstone (
    element_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    property_schema_id TEXT NOT NULL,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_property_value_element_tomb_node
    ON property_value_element_tombstone (node_id);

CREATE TABLE IF NOT EXISTS property_value_tombstone (
    node_id TEXT NOT NULL,
    property_schema_id TEXT NOT NULL,
    idx INTEGER NOT NULL DEFAULT 0,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    PRIMARY KEY (node_id, property_schema_id, idx)
);

-- Derived reference index (never authored). type: mention | typed_link |
-- property. verb: the typed-link verb (string) or the bound propertySchemaId;
-- NULL for plain mentions. target_id is NULL for typed_link marks (the
-- target is unresolved by design — RECORD, DON'T RESOLVE).
CREATE TABLE IF NOT EXISTS edge (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT,
    type TEXT NOT NULL,
    verb TEXT,
    metadata TEXT,
    created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_edge_source ON edge (source_id, type);
CREATE INDEX IF NOT EXISTS idx_edge_target ON edge (target_id, type);

-- Link analytics assertions, keyed by the mention token's optional linkId
-- (SCHEMA.md, decided 2026-09-26). Anonymous mentions (no linkId) get no row.
CREATE TABLE IF NOT EXISTS node_link (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT,
    click_count INTEGER NOT NULL DEFAULT 0,
    last_navigated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_node_link_source ON node_link (source_id);
CREATE INDEX IF NOT EXISTS idx_node_link_target ON node_link (target_id);
CREATE INDEX IF NOT EXISTS idx_node_link_source_target
    ON node_link (source_id, target_id);

CREATE TABLE IF NOT EXISTS node_asset (
    node_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    original_name TEXT NOT NULL DEFAULT '',
    uploaded_at TEXT,
    PRIMARY KEY (node_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_node_asset_hash ON node_asset (hash);

-- OR-Set membership for collection nodes (add-wins, LWW per member pair).
CREATE TABLE IF NOT EXISTS collection_member (
    collection_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    present INTEGER NOT NULL,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    PRIMARY KEY (collection_id, object_id)
);

CREATE INDEX IF NOT EXISTS idx_collection_member_object
    ON collection_member (object_id);

-- FTS5 over derived node plaintext (FTS4 before; same docid-map pattern).
-- Rows are addressed by rowid through search_index_docid. The docid index is
-- load-bearing: without it the join from FTS rowids back to node ids degrades
-- to a full docid-map scan per matched row, and a common-prefix query (e.g.
-- "de*" on a Spanish corpus) wedges the whole process at 100% CPU.
${SEARCH_INDEX_DDL_FTS5}

CREATE TABLE IF NOT EXISTS search_index_docid (
    node_id TEXT PRIMARY KEY,
    docid INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_index_docid_docid
    ON search_index_docid (docid);

CREATE TABLE IF NOT EXISTS node_stats (
    node_id TEXT PRIMARY KEY,
    child_count INTEGER NOT NULL DEFAULT 0,
    backlink_count INTEGER NOT NULL DEFAULT 0,
    reference_count INTEGER NOT NULL DEFAULT 0,
    descendant_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
);

-- Operation-log idempotency: envelope ids already applied are skipped, so
-- replaying a fixture (or a whole catch-up batch) never double-applies.
CREATE TABLE IF NOT EXISTS applied_envelope (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
    workspace_id TEXT PRIMARY KEY,
    cursor_seq INTEGER NOT NULL DEFAULT 0,
    restore_epoch INTEGER NOT NULL DEFAULT 0
);

-- Remote-history quarantine: an op that fails to apply inside a remote
-- batch (e.g. a pre-Revision-11 envelope violating a post-migration guard)
-- is recorded here INSTEAD of bricking the page — the batch keeps
-- converging and the sync engine surfaces the error. Local authoring
-- (Store.apply) still fails loud; quarantine is replay-only.
CREATE TABLE IF NOT EXISTS quarantined_envelope (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    op_type TEXT NOT NULL,
    error TEXT NOT NULL,
    payload TEXT NOT NULL,
    quarantined_at TEXT NOT NULL
);

-- Durable local op log: every locally-authored envelope is recorded here
-- before it can be pushed, and cleared when the server acknowledges it.
-- Unlike the engine's in-memory outbox, this survives reloads, so offline
-- work is never lost and can be pushed on the first later connection
-- (login). Remote-applied envelopes never enter this table.
CREATE TABLE IF NOT EXISTS local_op_log (
    id TEXT PRIMARY KEY,
    envelope TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    pushed_at INTEGER
);

-- Soft-delete retention. is_permanent distinguishes trash rows recorded for
-- retention cleanup before a hard delete from plain soft deletes.
CREATE TABLE IF NOT EXISTS trash (
    node_id TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL,
    is_permanent INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_trash_deleted_at ON trash (deleted_at);

CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Per-workspace feature toggles (the workspace.feature.set op): the
-- winning LWW row per (workspace_id, feature); an ABSENT row means enabled
-- (all features default ON — the empty table is the pre-toggle state, so
-- existing workspaces need no migration). The applier derives the
-- membership-preserving archival of the feature's managed system classes
-- from this row (class registry active bit + the class node's is_active;
-- class_member_set rows are never touched).
CREATE TABLE IF NOT EXISTS workspace_feature (
    workspace_id TEXT NOT NULL,
    feature TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    PRIMARY KEY (workspace_id, feature)
);
`;

const SCHEMA_SQL_FTS4 = SCHEMA_SQL.replace(
  SEARCH_INDEX_DDL_FTS5,
  SEARCH_INDEX_DDL_FTS5.replace("fts5(", "fts4("),
);

/** Create or upgrade the derived schema in ``db`` (PRAGMA user_version). */
export function migrate(
  db: Pick<SqliteDB, "pragma" | "exec" | "prepare">,
  ftsModule: FtsModule = "fts5",
): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current === SCHEMA_VERSION) return;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `store schema v${SCHEMA_VERSION} cannot open database at user_version ${current} ` +
        "(newer store required)",
    );
  }
  db.exec(schemaSql(ftsModule));
  // v5 -> v6: tags. node.tag_ids backfill for pre-existing databases
  // (CREATE TABLE never alters); the member table is CREATE IF NOT EXISTS.
  if (current < 6) {
    const nodeColumns = db.prepare("PRAGMA table_info(node)").all() as { name: string }[];
    if (!nodeColumns.some((c) => c.name === "tag_ids")) {
      db.exec("ALTER TABLE node ADD COLUMN tag_ids TEXT NOT NULL DEFAULT '[]';");
    }
  }
  // v6 -> v7: class order. node.class_order backfill for pre-existing
  // databases (CREATE TABLE never alters).
  if (current < 7) {
    const nodeColsV7 = db.prepare("PRAGMA table_info(node)").all() as { name: string }[];
    if (!nodeColsV7.some((c) => c.name === "class_order")) {
      db.exec("ALTER TABLE node ADD COLUMN class_order TEXT NOT NULL DEFAULT '[]';");
    }
  }
  // v7 -> v8: the render-state model replaces node_type with the two
  // booleans. Table rebuild (works on old SQLite builds — no DROP COLUMN):
  // node_v8 carries is_class / present_as_main, the rows map
  // page -> (0, 1), block -> (0, 0), class -> (1, 0), and the two node
  // indexes are recreated on the rebuilt table. The old "block needs a
  // parent" CHECK disappears with the column: parentless non-class nodes
  // are legal now (document chrome by the second cascade branch).
  if (current < 8) {
    const nodeColsV8 = db.prepare("PRAGMA table_info(node)").all() as { name: string }[];
    if (nodeColsV8.some((c) => c.name === "node_type")) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE node_v8 (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            is_class INTEGER NOT NULL DEFAULT 0,
            present_as_main INTEGER NOT NULL DEFAULT 0,
            parent_id TEXT REFERENCES node_v8(id),
            class_ids TEXT NOT NULL DEFAULT '[]',
            class_order TEXT NOT NULL DEFAULT '[]',
            tag_ids TEXT NOT NULL DEFAULT '[]',
            name TEXT,
            content TEXT NOT NULL DEFAULT '[]',
            icon TEXT,
            color TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT,
            updated_at TEXT,
            created_by TEXT,
            updated_by TEXT,
            hlc_physical INTEGER NOT NULL DEFAULT 0,
            hlc_logical INTEGER NOT NULL DEFAULT 0,
            actor_id TEXT,
            CHECK (is_class = 0 OR parent_id IS NULL)
        );
        INSERT INTO node_v8 (
            id, workspace_id, is_class, present_as_main, parent_id,
            class_ids, class_order, tag_ids, name, content, icon, color,
            is_active, created_at, updated_at, created_by, updated_by,
            hlc_physical, hlc_logical, actor_id
        )
        SELECT id, workspace_id,
            CASE WHEN node_type = 'class' THEN 1 ELSE 0 END,
            CASE WHEN node_type = 'page' THEN 1 ELSE 0 END,
            parent_id, class_ids, class_order, tag_ids, name, content, icon, color,
            is_active, created_at, updated_at, created_by, updated_by,
            hlc_physical, hlc_logical, actor_id
        FROM node;
        DROP TABLE node;
        ALTER TABLE node_v8 RENAME TO node;
        CREATE INDEX IF NOT EXISTS idx_node_workspace ON node (workspace_id);
        CREATE INDEX IF NOT EXISTS idx_node_parent ON node (parent_id);
        PRAGMA foreign_keys = ON;
      `);
    }
  }
  // v14 -> v15 (the render-path list reads): the composite
  // list-reads index. Runs after the v8 rebuild block so the node table is
  // guaranteed v8-shaped here; CREATE IF NOT EXISTS is idempotent (the
  // rebuild above just created it for pre-v8 databases). Fresh databases
  // (current 0) arrive here with the v15 table and take the same path.
  if (current < 15) {
    db.exec(LIST_READS_INDEX_DDL);
  }
  // v2 -> v3: class_property gained LWW causality columns. Databases created
  // at v2 keep their rows; fresh v3 creates already have the columns, so the
  // backfill is a no-op there. (CREATE TABLE IF NOT EXISTS never alters.)
  const columns = db.prepare("PRAGMA table_info(class_property)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "hlc_physical")) {
    db.exec(`
      ALTER TABLE class_property ADD COLUMN hlc_physical INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE class_property ADD COLUMN hlc_logical INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE class_property ADD COLUMN actor_id TEXT;
    `);
  }
  // v3 -> v4: property_schema gained the SCHEMA.md "Dates" columns. Fresh v4
  // creates already have them; the ALTER backfills pre-existing databases
  // (NULL = default precision day / not qualified).
  const schemaColumns = db.prepare("PRAGMA table_info(property_schema)").all() as {
    name: string;
  }[];
  if (!schemaColumns.some((c) => c.name === "date_precision")) {
    db.exec(`
      ALTER TABLE property_schema ADD COLUMN date_precision TEXT;
      ALTER TABLE property_schema ADD COLUMN date_qualified INTEGER;
    `);
  }
  // v11 -> v12: number display formatting (SCHEMA.md "Number formats").
  // Additive columns, NULL = unformatted; the column guard keeps the ALTER
  // idempotent for databases that already carry them (a v12 create).
  if (current < 12 && !schemaColumns.some((c) => c.name === "number_pad")) {
    db.exec(`
      ALTER TABLE property_schema ADD COLUMN number_pad INTEGER;
      ALTER TABLE property_schema ADD COLUMN number_decimals INTEGER;
      ALTER TABLE property_schema ADD COLUMN number_rounding TEXT;
    `);
  }
  // v8 -> v9: remote-history quarantine table (CREATE IF NOT EXISTS is a
  // no-op for fresh v9 creates; existing databases gain the table).
  db.exec(`
    CREATE TABLE IF NOT EXISTS quarantined_envelope (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        op_type TEXT NOT NULL,
        error TEXT NOT NULL,
        payload TEXT NOT NULL,
        quarantined_at TEXT NOT NULL
    );
  `);
  // v9 -> v10: per-workspace feature toggles. Purely additive —
  // CREATE IF NOT EXISTS is a no-op for fresh v10 creates; existing
  // databases gain the empty table (empty = all features enabled).
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_feature (
        workspace_id TEXT NOT NULL,
        feature TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        hlc_physical INTEGER NOT NULL DEFAULT 0,
        hlc_logical INTEGER NOT NULL DEFAULT 0,
        actor_id TEXT,
        PRIMARY KEY (workspace_id, feature)
    );
  `);
  // v10 -> v11 (the property-wire batch: PG5 element identity + PC4
  // binding active). Three additive steps, each guarded so a fresh v11
  // create (which already has them) is untouched:
  // (1) class_property gains the soft-unbind flag — absent column means the
  //     pre-PC4 state, which IS active, so the backfill default is 1.
  const classPropertyColumns = db.prepare("PRAGMA table_info(class_property)").all() as {
    name: string;
  }[];
  if (!classPropertyColumns.some((c) => c.name === "active")) {
    db.exec("ALTER TABLE class_property ADD COLUMN active INTEGER NOT NULL DEFAULT 1;");
  }
  // v13 -> v14 (owner review 2026-10-05 — the render contracts move
  // from the binding to the property). Two guarded steps, each idempotent
  // for a fresh v14 create:
  // (1) property_schema gains display + readonly/hide_when_empty
  //     (NULL = panel / unset). `required` deliberately stays on the binding.
  const schemaColumnsV14 = db.prepare("PRAGMA table_info(property_schema)").all() as {
    name: string;
  }[];
  if (!schemaColumnsV14.some((c) => c.name === "display")) {
    db.exec(`
      ALTER TABLE property_schema ADD COLUMN display TEXT;
      ALTER TABLE property_schema ADD COLUMN readonly INTEGER;
      ALTER TABLE property_schema ADD COLUMN hide_when_empty INTEGER;
    `);
  }
  // (2) class_property is REBUILT without the retired binding columns
  //     (readonly/hide_when_empty from the original shape, display from the
  //     v13 experiment — the v11 property_value rebuild precedent:
  //     same surviving columns, rows copy verbatim, indexes recreated).
  //     `required` survives on the row (the owner's per-class exception).
  const classPropertyColumnsV14 = db.prepare("PRAGMA table_info(class_property)").all() as {
    name: string;
  }[];
  if (classPropertyColumnsV14.some((c) => c.name === "display" || c.name === "hide_when_empty")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE class_property_v14 (
          class_id TEXT NOT NULL,
          property_schema_id TEXT NOT NULL,
          sequence INTEGER NOT NULL DEFAULT 0,
          required INTEGER,
          default_value TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          hlc_physical INTEGER NOT NULL DEFAULT 0,
          hlc_logical INTEGER NOT NULL DEFAULT 0,
          actor_id TEXT,
          PRIMARY KEY (class_id, property_schema_id)
      );
      INSERT INTO class_property_v14 (
          class_id, property_schema_id, sequence, required, default_value, active,
          hlc_physical, hlc_logical, actor_id
      )
      SELECT class_id, property_schema_id, sequence, required, default_value, active,
             hlc_physical, hlc_logical, actor_id
      FROM class_property;
      DROP TABLE class_property;
      ALTER TABLE class_property_v14 RENAME TO class_property;
      CREATE INDEX IF NOT EXISTS idx_class_property_class ON class_property (class_id);
      PRAGMA foreign_keys = ON;
    `);
  }
  // (2) PG5 element tombstone table (CREATE IF NOT EXISTS is a no-op for
  //     fresh v11 creates).
  db.exec(`
    CREATE TABLE IF NOT EXISTS property_value_element_tombstone (
        element_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        property_schema_id TEXT NOT NULL,
        hlc_physical INTEGER NOT NULL DEFAULT 0,
        hlc_logical INTEGER NOT NULL DEFAULT 0,
        actor_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_property_value_element_tomb_node
        ON property_value_element_tombstone (node_id);
  `);
  // (3) property_value: the UNIQUE(node_id, property_schema_id, idx)
  //     constraint is retired (PG5 — per-element identity allows concurrent
  //     adds at the same idx; idx is an order hint only). SQLite cannot drop
  //     a table constraint, so the table is rebuilt (the v8 node-rebuild
  //     precedent): same columns, no UNIQUE, indexes recreated. Rows copy
  //     verbatim — the row id remains the (now element) id.
  const pvIndexes = db.prepare("PRAGMA index_list(property_value)").all() as Array<{
    name: string;
    origin: string;
  }>;
  if (pvIndexes.some((i) => i.origin === "u")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE property_value_v11 (
          id TEXT PRIMARY KEY,
          node_id TEXT NOT NULL,
          property_schema_id TEXT NOT NULL,
          value TEXT NOT NULL,
          idx INTEGER NOT NULL DEFAULT 0,
          metadata TEXT,
          hlc_physical INTEGER NOT NULL DEFAULT 0,
          hlc_logical INTEGER NOT NULL DEFAULT 0,
          actor_id TEXT
      );
      INSERT INTO property_value_v11 (
          id, node_id, property_schema_id, value, idx, metadata,
          hlc_physical, hlc_logical, actor_id
      )
      SELECT id, node_id, property_schema_id, value, idx, metadata,
             hlc_physical, hlc_logical, actor_id
      FROM property_value;
      DROP TABLE property_value;
      ALTER TABLE property_value_v11 RENAME TO property_value;
      CREATE INDEX IF NOT EXISTS idx_property_value_node ON property_value (node_id);
      PRAGMA foreign_keys = ON;
    `);
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`);}
