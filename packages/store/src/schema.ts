/**
 * Derived-state SQLite schema for Notees (better-sqlite3, synchronous).
 *
 * Port of `app/core/derived/schema.py` + `frontend/src/core/db/schema.ts`
 * (client schema v22), adapted to the current model (SCHEMA.md):
 *  - the Revision-12 embedding model: `node.is_class` (identity marker,
 *    classes are always roots) + `node.is_embedded` (embedding flag for
 *    parented non-class nodes: 1 = the parent's body — the Block role,
 *    0 = a standalone structural element — the Page role; Revision 12
 *    renames and inverts the retired `present_as_main` render bit) replace
 *    the retired node_type enumeration;
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
import { resolveEdgeTarget } from "./edges.js";
import { dropSearchIndex, reindexAllSearch } from "./search.js";

export const SCHEMA_VERSION = 30;

/**
 * The render-path list-reads index: composite for the
 * listClasses/listPages/roots WHERE (workspace_id, is_class, is_active) +
 * ORDER BY COALESCE(name, id), id — the profiled full-scan+sort per render
 * burst. Kept OUT of the canonical schema DDL on purpose: migrate()'s
 * canonical exec runs before the rebuild ladder, where pre-v8 node tables
 * don't have is_class yet. Version-gated ladder step +
 * explicit re-assert on the snapshot-repair path instead (single source here).
 */
export const LIST_READS_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_node_list_reads ON node (workspace_id, is_class, is_active, name, id);";

/** FTS module for the search_index virtual table (backend capability). */
export type FtsModule = "fts5" | "fts4";

/**
 * The v17 resolved-target read index on edge. Kept OUT of the canonical
 * schema DDL on purpose: migrate()'s canonical exec runs before the version
 * ladder, where pre-v17 edge tables don't have resolved_target_id yet
 * (the LIST_READS_INDEX_DDL precedent). The ladder adds it after the
 * column-guarded ALTER; the snapshot-repair path re-asserts it explicitly.
 */
export const RESOLVED_TARGET_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_edge_resolved_target ON edge (resolved_target_id);";

/**
 * The v20 bulk-replay read indexes (owner 2026-10-16 — profiled during the
 * parent-page migration dry-run: replaying a 50k-op log tail ran 20× slower
 * than live-paced application because two per-op lookups full-scanned their
 * tables — every reresolveEdgeTargets alias-closure walk scans node by
 * aliased_node_id, and the child-order-by-child cleanup scans
 * node_child_order by child_id). Both are live-paced-invisible, bulk-replay-
 * dominant. Kept OUT of the canonical schema DDL for the
 * RESOLVED_TARGET_INDEX_DDL reason: pre-v16 node tables lack
 * aliased_node_id, and migrate()'s canonical exec runs before the ladder
 * (the column-guarded v16 ALTER lands earlier in the linear ladder, so a
 * single `current < 20` step is safe). The snapshot-repair path re-asserts
 * them explicitly, the LIST_READS_INDEX_DDL precedent.
 */
export const ALIAS_SOURCE_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_node_aliased_source ON node (aliased_node_id);";
export const CHILD_ORDER_CHILD_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_node_child_order_child ON node_child_order (child_id);";

const SEARCH_INDEX_DDL_FTS5 = `CREATE VIRTUAL TABLE IF NOT EXISTS search_index
    USING fts5(content, tokenize = 'unicode61');`;

/**
 * The v19 diacritic-folding rebuild (kept OUT of the canonical schema DDL
 * for the RESOLVED_TARGET_INDEX_DDL reason: migrate()'s canonical exec is a
 * CREATE IF NOT EXISTS no-op on existing tables). Folding is INDEX-TIME,
 * not tokenizer-level: reindexNode stores diacritic-stripped plaintext and
 * the MATCH terms are folded in JS before they reach SQLite — the stock
 * sql.js build's FTS4 unicode61 tokenizer rejects `remove_diacritics`
 * (verified against the shipped wasm), so a tokenizer option is off the
 * table for the browser backend. A virtual table's rows cannot be UPDATEd
 * in place with new text either — pre-v19 indexes are dropped and rebuilt
 * from the derived plaintext.
 */
const SEARCH_INDEX_DDL = (ftsModule: FtsModule): string =>
  ftsModule === "fts5" ? SEARCH_INDEX_DDL_FTS5 : SEARCH_INDEX_DDL_FTS5.replace("fts5(", "fts4(");

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
    -- Revision-12 embedding model (replaces the node_type enumeration and
    -- Revision 11's present_as_main render bit, renamed + inverted):
    -- is_class is the ONLY identity marker — classes are always roots;
    -- is_embedded is the embedding flag read by the third cascade branch
    -- for parented non-class nodes: 1 (the DEFAULT) = the node's content
    -- belongs to the parent's body — the Block role, inline + block
    -- chrome; 0 = a standalone structural element under the parent — the
    -- Page role, the main-children zone + document chrome when zoomed.
    -- The flag is unread for parentless nodes (document chrome by the
    -- second branch) and for classes (ClassView by the first branch).
    is_class INTEGER NOT NULL DEFAULT 0,
    is_embedded INTEGER NOT NULL DEFAULT 1,
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
    -- Wire node fields (the icon/color precedent): platform-fixed node
    -- fundamentals set via object.update (never object.create) — the asset
    -- node behind the page cover/banner chrome, the main page a node
    -- alias points at (many-to-one FROM the alias), and the page subtitle
    -- in the core chrome (the Capacities header precedent, max 512 chars).
    -- NULL = unset; present-null on the wire CLEARS. Reference integrity is
    -- a read-layer concern (the applier maps, it does not validate).
    cover_asset_id TEXT,
    banner_asset_id TEXT,
    aliased_node_id TEXT,
    description TEXT,
    -- Per-block list style (SCHEMA.md "Node structure", store v23): the bullet
    -- dot's replacement — "numbered" | "alpha" | "roman". NULL = bullet (the
    -- default); the NUMBER is never stored — clients derive it at render time
    -- from the contiguous run of same-style siblings.
    list_style TEXT,
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
    -- The schema's icon (owner 2026-10-20): an MDI icon name; NULL = none.
    icon TEXT,
    -- The SOLE locality authority (owner ruling 2026-10-20, R1; store v24):
    -- a JSON array of class ids, NULL = GLOBAL (any node may carry the
    -- property). A non-empty list is LOCAL to those classes and their
    -- extends-ancestors (eligibility walks class_hierarchy, the same closure
    -- binding resolution uses). RETIRES the display-only scope TEXT column
    -- (rebuilt away at v24; the live log rewrite is
    -- scripts/migrate-property-scope.mts). Bindings (class_property rows)
    -- carry ZERO availability semantics — scope says who MAY carry the
    -- property; a binding says what a class DOES WITH it.
    scope_class_ids TEXT,
    -- Value validation rules (owner 2026-10-20), JSON {min?, max?, pattern?};
    -- NULL = none. min/max apply to number schemas, pattern to
    -- text/url/email (apply-time enforcement against the stored type).
    validation_rules TEXT,
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
    -- hide-when-empty flag, wherever the property appears (class-bound
    -- or not). The readonly flag retired outright at v27 (owner ruling
    -- 2026-10-21): never user configuration (no seed ever carried it),
    -- clients DERIVE it from the system property list
    -- (@notees/domain isReadonlyProperty) — the strict schemas reject
    -- the retired key; the live log rewrite is
    -- scripts/migrate-drop-schema-readonly.mts.
    display TEXT,
    hide_when_empty INTEGER,
    -- The property's DEFAULT VALUE (owner ruling 2026-10-20, store v25 —
    -- moved from the class binding to the schema, the Logseq shape): ONE
    -- global default per property, JSON-encoded, typed per the schema type
    -- (PC2, validated at apply; node-typed schemas carry JSON null only).
    -- NULL = no default. The derived-read law: the applier never writes
    -- property_value rows for it; the effective read derives it.
    default_value TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_property_schema_workspace
    ON property_schema (workspace_id);

-- Class -> property binding rows, authored by
-- class.property.set / class.property.unset (SCHEMA.md "Class properties").
-- Row-level LWW by (hlc, actor): the winning write's causality is stored on
-- the row, so a stale set replayed after a newer one is dropped.
-- (owner ruling 2026-10-21, store v26): the row carries ONLY the soft-unbind
-- flag. 'sequence' retired outright (class panels render alphabetically by
-- property name — pure read-time derivation, nothing to configure); the live
-- log rewrite is scripts/migrate-drop-binding-sequence.mts (Path B).
-- 'required'/'default_value' retired/moved at v25,
-- scripts/migrate-drop-binding-required.mts.
-- 'active' (PC4): the soft-unbind flag — an inactive row stops contributing
-- to the effective read; authored values survive.
CREATE TABLE IF NOT EXISTS class_property (
    class_id TEXT NOT NULL,
    property_schema_id TEXT NOT NULL,
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

-- Node-level property ASSIGNMENT (owner ruling 2026-10-23 — the v1
-- node_property table lineage): the (node, property) pair declaration
-- WITHOUT a value. The effective read synthesizes an empty panel row for a
-- live assignment whose schema has no authored/default rows; the row's own
-- editor authors the first value via an ordinary property.set. Presence row,
-- LWW by the full (hlc, actor) tuple (the class_property precedent);
-- property.unassign deletes the row (the class.property.unset precedent).
-- Zero availability semantics — scope stays the sole locality authority,
-- enforced at the applier (R3).
CREATE TABLE IF NOT EXISTS node_property (
    node_id TEXT NOT NULL,
    property_schema_id TEXT NOT NULL,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    PRIMARY KEY (node_id, property_schema_id)
);

CREATE INDEX IF NOT EXISTS idx_node_property_node ON node_property (node_id);

-- Derived reference index (never authored). type: mention | typed_link |
-- property. verb: the typed-link verb (string) or the bound propertySchemaId;
-- NULL for plain mentions. target_id is NULL for typed_link marks (the
-- target is unresolved by design — RECORD, DON'T RESOLVE).
-- resolved_target_id (v17): the alias-terminal of target_id, materialized
-- by the applier at edge-write time (resolveEdgeTarget — the live-aware
-- chain walk; non-alias targets resolve to their own id; NULL stays NULL).
-- The backlinks roll-up and the graph read this column instead of walking
-- alias chains per query; maintained on alias writes and liveness flips by
-- reresolveEdgeTargets, backfilled for pre-v17 databases by migrate().
CREATE TABLE IF NOT EXISTS edge (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT,
    resolved_target_id TEXT,
    type TEXT NOT NULL,
    verb TEXT,
    metadata TEXT,
    -- Link embedding (owner 2026-10-16): the mention token's manual
    -- embedding flag (true = the link presents the target's content in
    -- place when it is its block's sole content). Default FALSE — an
    -- ordinary inline link; every pre-existing edge reads 0. Mined from
    -- the token at edge-write time; NOT part of the edge identity.
    is_embedded INTEGER NOT NULL DEFAULT 0,
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

-- External-id mappings for importer/sync plugins (the external_ref.* ops,
-- owner 2026-10-23): durable external -> internal id pairs (a Google
-- Calendar event UID, a Readwise highlight id -> the notees node uuid) so
-- re-runs update instead of duplicating. One LIVE mapping per ref — LWW by
-- envelope (hlc, actor) on the ref key, so a re-set moves the mapping and
-- racing writes converge on the higher tuple; a node may carry MANY refs
-- (the reverse read scans by node_id). No referential integrity by design
-- (the property_value precedent): a mapping may name a node another device
-- has not synced yet. A node's HARD delete purges its live rows (the
-- subtreeIds pattern in the object.delete applier); soft-trash keeps them.
CREATE TABLE IF NOT EXISTS external_ref (
    ref TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    PRIMARY KEY (workspace_id, ref)
);

CREATE INDEX IF NOT EXISTS idx_external_ref_node ON external_ref (node_id);

-- The delete side of the ref-key LWW (the property_value_tombstone
-- precedent): every winning delete records its causality — including a
-- delete of an UNMAPPED ref — so a stale set delivered after the winning
-- delete is dropped on every replica and wipe -> replay converges under
-- any delivery order. Keyed by (workspace, ref) only: the tombstones of a
-- hard-deleted node's refs survive it (they bound garbage to that ref name).
CREATE TABLE IF NOT EXISTS external_ref_tombstone (
    ref TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    PRIMARY KEY (workspace_id, ref)
);
`;

const SCHEMA_SQL_FTS4 = SCHEMA_SQL.replace(
  SEARCH_INDEX_DDL_FTS5,
  SEARCH_INDEX_DDL_FTS5.replace("fts5(", "fts4("),
);

/** Create or upgrade the derived schema in ``db`` (PRAGMA user_version). */
export function migrate(
  db: Pick<SqliteDB, "pragma" | "exec" | "prepare" | "transaction">,
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
  //     (NULL = panel / unset). `required` deliberately stays on the
  //     binding. (`readonly` retired outright at v27, owner ruling
  //     2026-10-21 — the additive guard stays for pre-v14 databases and
  //     the v27 rebuild drops the column.)
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
  //     `required` survived the v14 rebuild then (the owner's per-class
  //     exception) and retired with `default_value` at v25.
  const classPropertyColumnsV14 = db.prepare("PRAGMA table_info(class_property)").all() as {
    name: string;
  }[];
  if (
    classPropertyColumnsV14.some((c) => c.name === "display" || c.name === "hide_when_empty") &&
    classPropertyColumnsV14.some((c) => c.name === "required")
  ) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE class_property_v14 (
          class_id TEXT NOT NULL,
          property_schema_id TEXT NOT NULL,
          required INTEGER,
          default_value TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          hlc_physical INTEGER NOT NULL DEFAULT 0,
          hlc_logical INTEGER NOT NULL DEFAULT 0,
          actor_id TEXT,
          PRIMARY KEY (class_id, property_schema_id)
      );
      INSERT INTO class_property_v14 (
          class_id, property_schema_id, required, default_value, active,
          hlc_physical, hlc_logical, actor_id
      )
      SELECT class_id, property_schema_id, required, default_value, active,
             hlc_physical, hlc_logical, actor_id
      FROM class_property;
      DROP TABLE class_property;
      ALTER TABLE class_property_v14 RENAME TO class_property;
      CREATE INDEX IF NOT EXISTS idx_class_property_class ON class_property (class_id);
      PRAGMA foreign_keys = ON;
    `);
  } else if (classPropertyColumnsV14.some((c) => c.name === "display" || c.name === "hide_when_empty")) {
    // The v25 shape already dropped required/default_value but the table
    // still carries the pre-v14 render columns (a current-shape database
    // downgraded past v14 — the migration tests exercise exactly that) —
    // rebuild straight to the current column set.
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE class_property_v25pre (
          class_id TEXT NOT NULL,
          property_schema_id TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          hlc_physical INTEGER NOT NULL DEFAULT 0,
          hlc_logical INTEGER NOT NULL DEFAULT 0,
          actor_id TEXT,
          PRIMARY KEY (class_id, property_schema_id)
      );
      INSERT INTO class_property_v25pre (
          class_id, property_schema_id, active, hlc_physical, hlc_logical, actor_id
      )
      SELECT class_id, property_schema_id, active, hlc_physical, hlc_logical, actor_id
      FROM class_property;
      DROP TABLE class_property;
      ALTER TABLE class_property_v25pre RENAME TO class_property;
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
  // v15 -> v16: the wire node fields (SCHEMA.md "Node structure" — the
  // cover/banner asset refs and the node-alias target, the icon/color
  // precedent) land as three nullable node columns mapped by object.update.
  // Purely additive; the column guard keeps the ALTER idempotent for fresh
  // v16 creates (CREATE TABLE IF NOT EXISTS never alters).
  if (current < 16) {
    const nodeColumnsV16 = db.prepare("PRAGMA table_info(node)").all() as { name: string }[];
    if (!nodeColumnsV16.some((c) => c.name === "cover_asset_id")) {
      db.exec(`
        ALTER TABLE node ADD COLUMN cover_asset_id TEXT;
        ALTER TABLE node ADD COLUMN banner_asset_id TEXT;
        ALTER TABLE node ADD COLUMN aliased_node_id TEXT;
      `);
    }
  }
  // v16 -> v17: the alias resolved-target materialization (the documented
  // later optimization for the backlinks roll-up — the edge index gains
  // resolved_target_id, the applier-maintained alias-terminal of target_id).
  // Two guarded steps: (1) the additive column + index (a no-op for fresh
  // v17 creates); (2) the backfill — every row re-resolved through the SAME
  // live-aware chain walk the applier writes with (resolveEdgeTarget), so a
  // migrated database is byte-identical to a wipe -> replay at v17. NULL
  // targets (typed_link marks) backfill to NULL explicitly. Idempotent: a
  // second migrate re-resolves to the same values.
  if (current < 17) {
    const edgeColumnsV17 = db.prepare("PRAGMA table_info(edge)").all() as { name: string }[];
    if (!edgeColumnsV17.some((c) => c.name === "resolved_target_id")) {
      db.exec("ALTER TABLE edge ADD COLUMN resolved_target_id TEXT;");
    }
    db.exec(RESOLVED_TARGET_INDEX_DDL);
    const targets = db
      .prepare("SELECT DISTINCT target_id FROM edge WHERE target_id IS NOT NULL")
      .all() as Array<{ target_id: string }>;
    const update = db.prepare("UPDATE edge SET resolved_target_id = ? WHERE target_id = ?");
    for (const row of targets) {
      update.run(resolveEdgeTarget(db, row.target_id), row.target_id);
    }
    db.exec("UPDATE edge SET resolved_target_id = NULL WHERE target_id IS NULL");
  }
  // v17 -> v18: the page-subtitle wire node field (SCHEMA.md "Node structure"
  // — `description`, the Capacities header precedent) lands as a nullable
  // node column mapped by object.update. Purely additive; the column guard
  // keeps the ALTER idempotent for fresh v18 creates (CREATE TABLE IF NOT
  // EXISTS never alters).
  if (current < 18) {
    const nodeColumnsV18 = db.prepare("PRAGMA table_info(node)").all() as { name: string }[];
    if (!nodeColumnsV18.some((c) => c.name === "description")) {
      db.exec("ALTER TABLE node ADD COLUMN description TEXT;");
    }
  }
  // v18 -> v19: diacritic folding in the FTS index (index-time folding —
  // `peru` matches "Perú"). A virtual table's rows cannot be UPDATEd with
  // re-tokenized text, so a pre-v19 index is dropped and rebuilt from the
  // derived plaintext (now folded at insert). Version-gated: every
  // pre-v19 database has unfolded rows by construction. The rebuild only
  // runs when the parked table's module matches the connection's declared
  // module — a cross-backend parked table (restore the other direction) is
  // the repair path's job, and migrations always run locally before
  // snapshots ship, so folded rows travel with the bytes.
  if (current < 19) {
    const existing = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'search_index'")
      .get() as { sql: string | null } | undefined;
    const existingSql = existing?.sql?.toLowerCase() ?? null;
    const existingModule: FtsModule =
      existingSql === null ? ftsModule : existingSql.includes("using fts5") ? "fts5" : "fts4";
    if (existing !== undefined && existingModule === ftsModule) {
      try {
        db.exec("DROP TABLE IF EXISTS search_index");
        db.exec(SEARCH_INDEX_DDL(ftsModule));
        reindexAllSearch(db);
      } catch {
        // The module named in sqlite_master is not loadable on this
        // connection (a synthetic cross-backend restore): the
        // queryability repair path rebuilds with the local module, and
        // reindexNode folds at insert — nothing to do here.
      }
    }
  }
  // v19 -> v20: the bulk-replay read indexes (owner 2026-10-16 — profiled
  // during the parent-page migration dry-run: a 50k-op tail replay ran 20×
  // over live pace because the alias-closure walk and the child-order-by-
  // child cleanup full-scanned their tables). Both targets exist by here —
  // the node alias column lands at v16 and the child-order table is
  // pre-v1, so the linear ladder guarantees the shapes. CREATE INDEX IF NOT
  // EXISTS is idempotent for fresh creates (they arrive here at v20-shaped
  // tables and take the same path).
  if (current < 20) {
    db.exec(ALIAS_SOURCE_INDEX_DDL);
    db.exec(CHILD_ORDER_CHILD_INDEX_DDL);
  }
  // v21 -> v22: the link-embedding flag (owner 2026-10-16) — `edge`
  // gains `is_embedded INTEGER NOT NULL DEFAULT 0`, the derived projection
  // of the mention token's manual embedding flag. Purely additive: existing
  // edges converge to 0 (every pre-existing link is an ordinary inline
  // link — the owner ruling's backfill), fresh creates carry the column,
  // and the applier re-mines the flag on every content write. Guarded
  // ALTER (the v16 precedent); no table rebuild.
  if (current < 22) {
    const edgeColsV22 = db.prepare("PRAGMA table_info(edge)").all() as { name: string }[];
    if (!edgeColsV22.some((c) => c.name === "is_embedded")) {
      db.exec("ALTER TABLE edge ADD COLUMN is_embedded INTEGER NOT NULL DEFAULT 0");
    }
  }
  // v20 -> v21: the Revision-12 embedding flag — `present_as_main` is
  // renamed to `is_embedded` WITH POLARITY INVERSION (is_embedded =
  // 1 - present_as_main: the old main-zone bit 1 becomes the standalone
  // claim 0, the old inline-body 0 becomes the embedded default 1; the
  // op-log rewrite, scripts/migrate-is-embedded.mts, moves the wire at the
  // same bump — the derived store is a projection and converges by replay,
  // this ladder step only heals pre-existing local bytes in place). Table
  // rebuild (no DROP COLUMN on old SQLite builds); every other column
  // rides through untouched. Guarded on the old column so the step is a
  // no-op for databases that already carry is_embedded (idempotent).
  if (current < 21) {
    const nodeColsV21 = db.prepare("PRAGMA table_info(node)").all() as { name: string }[];
    if (nodeColsV21.some((c) => c.name === "present_as_main")) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE node_v21 (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            is_class INTEGER NOT NULL DEFAULT 0,
            is_embedded INTEGER NOT NULL DEFAULT 1,
            parent_id TEXT REFERENCES node_v21(id),
            class_ids TEXT NOT NULL DEFAULT '[]',
            class_order TEXT NOT NULL DEFAULT '[]',
            tag_ids TEXT NOT NULL DEFAULT '[]',
            name TEXT,
            content TEXT NOT NULL DEFAULT '[]',
            icon TEXT,
            color TEXT,
            cover_asset_id TEXT,
            banner_asset_id TEXT,
            aliased_node_id TEXT,
            description TEXT,
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
        INSERT INTO node_v21 (
            id, workspace_id, is_class, is_embedded, parent_id,
            class_ids, class_order, tag_ids, name, content, icon, color,
            cover_asset_id, banner_asset_id, aliased_node_id, description,
            is_active, created_at, updated_at, created_by, updated_by,
            hlc_physical, hlc_logical, actor_id
        )
        -- The polarity inversion (is_embedded = 1 - present_as_main):
        -- the old main-zone bit 1 becomes the standalone claim 0, the old
        -- inline-body 0 becomes the embedded default 1. Class rows
        -- converge to 0 explicitly (their old bit was already the cleared
        -- value; the appliers' canonical class writes store 0 — the two
        -- paths must meet on the same stored shape).
        SELECT id, workspace_id, is_class,
            CASE WHEN is_class = 1 THEN 0
                 WHEN present_as_main = 1 THEN 0
                 ELSE 1 END,
            parent_id, class_ids, class_order, tag_ids, name, content, icon, color,
            cover_asset_id, banner_asset_id, aliased_node_id, description,
            is_active, created_at, updated_at, created_by, updated_by,
            hlc_physical, hlc_logical, actor_id
        FROM node;
        DROP TABLE node;
        ALTER TABLE node_v21 RENAME TO node;
        CREATE INDEX IF NOT EXISTS idx_node_workspace ON node (workspace_id);
        CREATE INDEX IF NOT EXISTS idx_node_parent ON node (parent_id);
        CREATE INDEX IF NOT EXISTS idx_node_list_reads ON node (workspace_id, is_class, is_active, name, id);
        CREATE INDEX IF NOT EXISTS idx_node_aliased_source ON node (aliased_node_id);
        PRAGMA foreign_keys = ON;
      `);
    }
  }
  // v22 -> v23: the per-block list style (SCHEMA.md "Node structure" — the
  // listStyle wire node field, the icon/color precedent) lands as a nullable
  // node column mapped by object.create/update. Purely additive; the column
  // guard keeps the ALTER idempotent for fresh v23 creates (CREATE TABLE IF
  // EXISTS never alters), and it runs after every node-table rebuild above so
  // pre-v21 databases arrive at the current shape through the same path.
  {
    const nodeColumnsV23 = db.prepare("PRAGMA table_info(node)").all() as { name: string }[];
    if (!nodeColumnsV23.some((c) => c.name === "list_style")) {
      db.exec("ALTER TABLE node ADD COLUMN list_style TEXT;");
    }
  }
  // v23 -> v24 (owner ruling 2026-10-20 — the property-definition surfaces
  // batch): the property_schema table REBUILDS (the class_property v14
  // precedent — SQLite cannot drop a column on old builds): the display-only
  // `scope` TEXT column retires (the locality authority is the new
  // `scope_class_ids` JSON column, NULL = global), and the schema gains
  // `icon` + `validation_rules` (both NULL = unset). Rows copy through with
  // the new columns NULL — the live log rewrite (scripts/migrate-property-
  // scope.mts, Path B) sets scope_class_ids from the retired enum and the
  // epoch bump makes every replica wipe + resync, so converged bytes never
  // depend on this backfill. Guarded on the old column so the step is a
  // no-op for databases that already carry the new shape (idempotent).
  {
    const schemaColsV24 = db.prepare("PRAGMA table_info(property_schema)").all() as { name: string }[];
    if (schemaColsV24.some((c) => c.name === "scope")) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE property_schema_v24 (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            multi INTEGER NOT NULL DEFAULT 0,
            icon TEXT,
            scope_class_ids TEXT,
            validation_rules TEXT,
            options TEXT NOT NULL DEFAULT '[]',
            target_class_filter TEXT,
            date_precision TEXT,
            date_qualified INTEGER,
            number_pad INTEGER,
            number_decimals INTEGER,
            number_rounding TEXT,
            display TEXT,
            hide_when_empty INTEGER,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT,
            updated_at TEXT
        );
        INSERT INTO property_schema_v24 (
            id, workspace_id, name, type, multi, icon, scope_class_ids, validation_rules,
            options, target_class_filter, date_precision, date_qualified,
            number_pad, number_decimals, number_rounding,
            display, hide_when_empty, active, created_at, updated_at
        )
        SELECT id, workspace_id, name, type, multi, NULL, NULL, NULL,
               options, target_class_filter, date_precision, date_qualified,
               number_pad, number_decimals, number_rounding,
               display, hide_when_empty, active, created_at, updated_at
        FROM property_schema;
        DROP TABLE property_schema;
        ALTER TABLE property_schema_v24 RENAME TO property_schema;
        CREATE INDEX IF NOT EXISTS idx_property_schema_workspace
            ON property_schema (workspace_id);
        PRAGMA foreign_keys = ON;
      `);
    } else {
      // Fresh v24 creates (and databases already carrying the new shape)
      // still gain the columns additively when missing.
      if (!schemaColsV24.some((c) => c.name === "scope_class_ids")) {
        db.exec(`
          ALTER TABLE property_schema ADD COLUMN icon TEXT;
          ALTER TABLE property_schema ADD COLUMN scope_class_ids TEXT;
          ALTER TABLE property_schema ADD COLUMN validation_rules TEXT;
        `);
      }
    }
  }
  // v24 -> v25 (owner ruling 2026-10-20 — the property-definition surfaces
  // batch, the binding-flags v14 precedent again): `required` retires
  // outright and `default_value` MOVES from class_property to
  // property_schema (one global default per property, the Logseq shape).
  // The binding table REBUILDS without both columns (SQLite cannot drop a
  // column on old builds); the schema gains `default_value` additively (NULL
  // = no default). The moved values arrive from the live log rewrite
  // (scripts/migrate-drop-binding-required.mts, Path B — appended
  // propertySchema.update compensation per affected schema) + the epoch
  // bump, so this backfill is deliberately NULL. Guarded on the old columns
  // so the step is a no-op for databases already carrying the new shape.
  {
    const bindingColsV25 = db.prepare("PRAGMA table_info(class_property)").all() as { name: string }[];
    if (bindingColsV25.some((c) => c.name === "required") || bindingColsV25.some((c) => c.name === "default_value")) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE class_property_v25 (
            class_id TEXT NOT NULL,
            property_schema_id TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            hlc_physical INTEGER NOT NULL DEFAULT 0,
            hlc_logical INTEGER NOT NULL DEFAULT 0,
            actor_id TEXT,
            PRIMARY KEY (class_id, property_schema_id)
        );
        INSERT INTO class_property_v25 (
            class_id, property_schema_id, active, hlc_physical, hlc_logical, actor_id
        )
        SELECT class_id, property_schema_id, active, hlc_physical, hlc_logical, actor_id
        FROM class_property;
        DROP TABLE class_property;
        ALTER TABLE class_property_v25 RENAME TO class_property;
        CREATE INDEX IF NOT EXISTS idx_class_property_class
            ON class_property (class_id);
        PRAGMA foreign_keys = ON;
      `);
    }
    const schemaColsV25 = db.prepare("PRAGMA table_info(property_schema)").all() as { name: string }[];
    if (!schemaColsV25.some((c) => c.name === "default_value")) {
      db.exec("ALTER TABLE property_schema ADD COLUMN default_value TEXT;");
    }
  }
  // v25 -> v26 (owner ruling 2026-10-21): `sequence` retires from the
  // binding — class panels render alphabetically by property name (pure
  // read-time derivation), so the column is gone. The binding table REBUILDS
  // without it (SQLite cannot drop a column on old builds); the live log
  // rewrite (scripts/migrate-drop-binding-sequence.mts, Path B) + the epoch
  // bump normalize the envelopes, so no value backfill exists. Guarded on
  // the old column so the step is a no-op for databases already carrying
  // the new shape.
  {
    const bindingColsV26 = db.prepare("PRAGMA table_info(class_property)").all() as { name: string }[];
    if (bindingColsV26.some((c) => c.name === "sequence")) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE class_property_v26 (
            class_id TEXT NOT NULL,
            property_schema_id TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            hlc_physical INTEGER NOT NULL DEFAULT 0,
            hlc_logical INTEGER NOT NULL DEFAULT 0,
            actor_id TEXT,
            PRIMARY KEY (class_id, property_schema_id)
        );
        INSERT INTO class_property_v26 (
            class_id, property_schema_id, active, hlc_physical, hlc_logical, actor_id
        )
        SELECT class_id, property_schema_id, active, hlc_physical, hlc_logical, actor_id
        FROM class_property;
        DROP TABLE class_property;
        ALTER TABLE class_property_v26 RENAME TO class_property;
        CREATE INDEX IF NOT EXISTS idx_class_property_class
            ON class_property (class_id);
        PRAGMA foreign_keys = ON;
      `);
    }
  }
  // v26 -> v27 (owner ruling 2026-10-21): `readonly` retires from the
  // property schema — never user configuration (no seed ever carried the
  // flag), so clients DERIVE readonly-ness from the system property list
  // (@notees/domain isReadonlyProperty) instead of storing it. The schema
  // table REBUILDS without the column (SQLite cannot drop a column on old
  // builds); the live log rewrite (scripts/migrate-drop-schema-readonly.mts,
  // Path B) + the epoch bump normalize the envelopes — no data backfill
  // (derived, not stored). Guarded on the old column so the step is a no-op
  // for databases already carrying the new shape.
  {
    const schemaColsV27 = db.prepare("PRAGMA table_info(property_schema)").all() as { name: string }[];
    if (schemaColsV27.some((c) => c.name === "readonly")) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE property_schema_v27 (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            multi INTEGER NOT NULL DEFAULT 0,
            icon TEXT,
            scope_class_ids TEXT,
            validation_rules TEXT,
            options TEXT NOT NULL DEFAULT '[]',
            target_class_filter TEXT,
            date_precision TEXT,
            date_qualified INTEGER,
            number_pad INTEGER,
            number_decimals INTEGER,
            number_rounding TEXT,
            display TEXT,
            hide_when_empty INTEGER,
            default_value TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT,
            updated_at TEXT
        );
        INSERT INTO property_schema_v27 (
            id, workspace_id, name, type, multi, icon, scope_class_ids, validation_rules,
            options, target_class_filter, date_precision, date_qualified,
            number_pad, number_decimals, number_rounding,
            display, hide_when_empty, default_value, active, created_at, updated_at
        )
        SELECT id, workspace_id, name, type, multi, icon, scope_class_ids, validation_rules,
               options, target_class_filter, date_precision, date_qualified,
               number_pad, number_decimals, number_rounding,
               display, hide_when_empty, default_value, active, created_at, updated_at
        FROM property_schema;
        DROP TABLE property_schema;
        ALTER TABLE property_schema_v27 RENAME TO property_schema;
        CREATE INDEX IF NOT EXISTS idx_property_schema_workspace
            ON property_schema (workspace_id);
        PRAGMA foreign_keys = ON;
      `);
    }
  }
  // v27 -> v28 (owner ruling 2026-10-23): the class registry `active` bit is
  // a PURE PROJECTION of the class node's liveness — mirrored on every arm
  // (archival, family toggles, user-class trash/restore, permanent purge) —
  // but rows written before the trash/restore/purge mirrors existed can
  // diverge: a registry row left ACTIVE after its class node was archived or
  // PURGED (the withdrawn system classes — `class` …0001, `page` …0002,
  // `cover` …0042 — minted exactly these ghosts, visible in every registry
  // read: node gone, `class.active = 1`). Pure derived-state scrub, no log
  // change: deactivate every registry row with no live class node behind it.
  // Idempotent — the NOT EXISTS predicate only ever flips rows to 0.
  db.exec(`
    UPDATE class SET active = 0, updated_at = '2026-10-23T00:00:00.000Z'
    WHERE active = 1
      AND NOT EXISTS (
        SELECT 1 FROM node
        WHERE node.id = class.id AND node.is_class = 1 AND node.is_active = 1
      );
  `);
  // v28 -> v29 (owner ruling 2026-10-23): node-level property assignment —
  // the v1 `node_property` lineage. Purely additive: CREATE IF NOT EXISTS is
  // a no-op for fresh v29 creates; existing databases gain the empty table
  // (the workspace_feature precedent).
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_property (
        node_id TEXT NOT NULL,
        property_schema_id TEXT NOT NULL,
        hlc_physical INTEGER NOT NULL DEFAULT 0,
        hlc_logical INTEGER NOT NULL DEFAULT 0,
        actor_id TEXT,
        PRIMARY KEY (node_id, property_schema_id)
    );
    CREATE INDEX IF NOT EXISTS idx_node_property_node ON node_property (node_id);
  `);
  // v29 -> v30 (owner requirement 2026-10-23): external-id mappings for
  // importer/sync plugins — the external_ref.* op family. Purely additive:
  // CREATE IF NOT EXISTS is a no-op for fresh v30 creates; existing
  // databases gain the empty tables (the workspace_feature precedent).
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_ref (
        ref TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        hlc_physical INTEGER NOT NULL DEFAULT 0,
        hlc_logical INTEGER NOT NULL DEFAULT 0,
        actor_id TEXT,
        PRIMARY KEY (workspace_id, ref)
    );
    CREATE INDEX IF NOT EXISTS idx_external_ref_node ON external_ref (node_id);
    CREATE TABLE IF NOT EXISTS external_ref_tombstone (
        ref TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        hlc_physical INTEGER NOT NULL DEFAULT 0,
        hlc_logical INTEGER NOT NULL DEFAULT 0,
        actor_id TEXT,
        PRIMARY KEY (workspace_id, ref)
    );
  `);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);}
