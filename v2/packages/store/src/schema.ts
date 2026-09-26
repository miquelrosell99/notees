/**
 * Derived-state SQLite schema for Notees v2 (better-sqlite3, synchronous).
 *
 * Port of v1 `app/core/derived/schema.py` + `frontend/src/core/db/schema.ts`
 * (client schema v22), adapted to the v2 model (SCHEMA.md):
 *  - `node.node_type` replaces v1 `kind` and takes a CHECK-enforced
 *    {page, block, class} enumeration with the two placement CHECKs from
 *    SCHEMA.md ("bullet-proof schema") — illegal states are unrepresentable;
 *  - FTS5 replaces v1 FTS4 (same node_id -> docid map pattern); the stock
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

export const SCHEMA_VERSION = 2;

/** FTS module for the search_index virtual table (backend capability). */
export type FtsModule = "fts5" | "fts4";

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
    node_type TEXT NOT NULL DEFAULT 'block'
        CHECK (node_type IN ('page', 'block', 'class')),
    parent_id TEXT REFERENCES node(id),
    class_ids TEXT NOT NULL DEFAULT '[]',
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
    CHECK (node_type <> 'block' OR parent_id IS NOT NULL),
    CHECK (node_type <> 'class' OR parent_id IS NULL)
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

-- Direct extends edges (m2m: a class may have MULTIPLE parents, per the
-- designed model in 01-knowledge-model.md §6). class.setExtends replaces
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
-- node id. The node row (node_type='class') is the structural authority;
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
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_property_schema_workspace
    ON property_schema (workspace_id);

-- Class -> property binding rows (sequence, flags, default). Registry rows
-- written by the schema-binding ops (none in the M1 registry; table kept so
-- the derived schema is complete and wipe -> replay -> identical).
CREATE TABLE IF NOT EXISTS class_property (
    class_id TEXT NOT NULL,
    property_schema_id TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,
    required INTEGER,
    readonly INTEGER,
    hide_when_empty INTEGER,
    default_value TEXT,
    PRIMARY KEY (class_id, property_schema_id)
);

CREATE INDEX IF NOT EXISTS idx_class_property_class
    ON class_property (class_id);

CREATE TABLE IF NOT EXISTS property_value (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    property_schema_id TEXT NOT NULL,
    value TEXT NOT NULL,
    idx INTEGER NOT NULL DEFAULT 0,
    metadata TEXT,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    UNIQUE (node_id, property_schema_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_property_value_node ON property_value (node_id);

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
-- target is unresolved by design — RECORD, DON'T RESOLVE until M2).
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

-- FTS5 over derived node plaintext (v1 used FTS4; same docid-map pattern).
-- Rows are addressed by rowid through search_index_docid.
CREATE VIRTUAL TABLE IF NOT EXISTS search_index
    USING fts5(content, tokenize = 'unicode61');

CREATE TABLE IF NOT EXISTS search_index_docid (
    node_id TEXT PRIMARY KEY,
    docid INTEGER NOT NULL
);

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
`;

const SCHEMA_SQL_FTS4 = SCHEMA_SQL.replace(
  "USING fts5(content, tokenize = 'unicode61')",
  "USING fts4(content, tokenize = 'unicode61')",
);

/** Create or upgrade the derived schema in ``db`` (PRAGMA user_version). */
export function migrate(
  db: {
    pragma(source: string, options?: { simple?: boolean }): unknown;
    exec(sql: string): unknown;
  },
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
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
