"""Derived-state SQLite schema for the Notees operation log.

The schema mirrors ``frontend/src/core/db/schema.ts`` but keeps the tables
needed for backend migration, query compilation, and feature-island ports.
All JSON-like columns are stored as TEXT so the schema works with the standard
``sqlite3`` module.
"""

from __future__ import annotations

import sqlite3

SCHEMA_SQL = """
-- Core operation-log tables (present in the frontend schema so that server-
-- generated snapshots can be restored without "no such column" errors).
CREATE TABLE IF NOT EXISTS operation (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    hlc_physical INTEGER NOT NULL,
    hlc_logical INTEGER NOT NULL,
    affected_node_ids TEXT NOT NULL,
    op_type TEXT NOT NULL,
    payload BLOB NOT NULL,
    timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operation_workspace_hlc
    ON operation (workspace_id, hlc_physical, hlc_logical);

CREATE TABLE IF NOT EXISTS snapshot (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    hlc_physical INTEGER NOT NULL,
    hlc_logical INTEGER NOT NULL,
    state_hash TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS compacted_operation_segment (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    from_hlc_physical INTEGER NOT NULL,
    from_hlc_logical INTEGER NOT NULL,
    to_hlc_physical INTEGER NOT NULL,
    to_hlc_logical INTEGER NOT NULL,
    snapshot_id TEXT NOT NULL,
    operation_count INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('page', 'block', 'class')),
    class_ids TEXT NOT NULL DEFAULT '[]',
    parent_id TEXT,
    content TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT,
    updated_at TEXT,
    created_by TEXT,
    updated_by TEXT,
    -- Server-only: used for last-write-wins content merging.
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS property_value (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    property_schema_id TEXT NOT NULL,
    value TEXT NOT NULL,
    idx INTEGER NOT NULL DEFAULT 0,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    UNIQUE(node_id, property_schema_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_property_value_node
    ON property_value (node_id);

CREATE TABLE IF NOT EXISTS property_value_tombstone (
    node_id TEXT NOT NULL,
    property_schema_id TEXT NOT NULL,
    idx INTEGER NOT NULL DEFAULT 0,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    PRIMARY KEY (node_id, property_schema_id, idx)
);

CREATE TABLE IF NOT EXISTS edge (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type TEXT NOT NULL,
    property_schema_id TEXT,
    metadata TEXT,
    created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_edge_source ON edge (source_id);
CREATE INDEX IF NOT EXISTS idx_edge_target ON edge (target_id);

CREATE TABLE IF NOT EXISTS crdt_state (
    node_id TEXT PRIMARY KEY,
    text_state BLOB,
    tree_state BLOB
);

CREATE TABLE IF NOT EXISTS class (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    description TEXT,
    extends_class_ids TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_class_workspace ON class (workspace_id);

CREATE TABLE IF NOT EXISTS class_hierarchy (
    class_id TEXT NOT NULL,
    ancestor_id TEXT NOT NULL,
    PRIMARY KEY (class_id, ancestor_id)
);

CREATE INDEX IF NOT EXISTS idx_class_hierarchy_ancestor
    ON class_hierarchy (ancestor_id);

CREATE TABLE IF NOT EXISTS property_schema (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT,
    type TEXT NOT NULL,
    multi INTEGER NOT NULL DEFAULT 0,
    is_system INTEGER NOT NULL DEFAULT 0,
    scope TEXT NOT NULL DEFAULT 'global',
    node_id TEXT,
    icon_visibility TEXT,
    validation_rules TEXT,
    required INTEGER NOT NULL DEFAULT 0,
    readonly INTEGER NOT NULL DEFAULT 0,
    hide_when_empty INTEGER NOT NULL DEFAULT 0,
    default_value TEXT,
    class_filter_uuids TEXT NOT NULL DEFAULT '[]',
    options TEXT NOT NULL DEFAULT '[]',
    computed TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_property_schema_workspace
    ON property_schema (workspace_id);

CREATE INDEX IF NOT EXISTS idx_property_schema_node
    ON property_schema (node_id);

CREATE TABLE IF NOT EXISTS class_property_edge (
    class_id TEXT NOT NULL,
    property_schema_id TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,
    default_value TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    required INTEGER,
    readonly INTEGER,
    hide_when_empty INTEGER,
    PRIMARY KEY (class_id, property_schema_id)
);

CREATE INDEX IF NOT EXISTS idx_class_property_edge_class
    ON class_property_edge (class_id);

CREATE INDEX IF NOT EXISTS idx_class_property_edge_property
    ON class_property_edge (property_schema_id);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts4(
    node_id,
    content,
    notindexed=node_id,
    tokenize=unicode61
);

CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_watermark (
    workspace_id TEXT PRIMARY KEY,
    hlc_physical INTEGER NOT NULL,
    hlc_logical INTEGER NOT NULL,
    restore_epoch INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_push_watermark (
    workspace_id TEXT PRIMARY KEY,
    hlc_physical INTEGER NOT NULL,
    hlc_logical INTEGER NOT NULL
);

-- Feature-island derived tables

CREATE TABLE IF NOT EXISTS node_asset (
    node_id TEXT NOT NULL,
    asset_hash TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    original_name TEXT NOT NULL DEFAULT '',
    uploaded_at TEXT,
    PRIMARY KEY (node_id, asset_hash)
);

CREATE INDEX IF NOT EXISTS idx_node_asset_hash ON node_asset (asset_hash);

CREATE TABLE IF NOT EXISTS task_completion (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    completed_at TEXT,
    actor_id TEXT,
    created_at TEXT,
    -- Server-only extras used by the task completion API.
    scheduled_date TEXT,
    deadline_date TEXT,
    status TEXT NOT NULL DEFAULT 'done'
);

CREATE INDEX IF NOT EXISTS idx_task_completion_node
    ON task_completion (node_id);

CREATE TABLE IF NOT EXISTS task_recurrence (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    rule TEXT NOT NULL,
    actor_id TEXT,
    created_at TEXT,
    -- Server-only extras used by the recurrence API.
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_recurrence_node
    ON task_recurrence (node_id);

CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    op_id TEXT NOT NULL UNIQUE,
    node_id TEXT,
    op_type TEXT,
    metadata TEXT,
    recorded_at TEXT,
    -- Server-only extras preserved for the activity API.
    action TEXT,
    target_node_id TEXT,
    details TEXT,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_log_node
    ON activity_log (node_id);

CREATE INDEX IF NOT EXISTS idx_activity_log_workspace_recorded
    ON activity_log (workspace_id, recorded_at);

CREATE TABLE IF NOT EXISTS link_click (
    node_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    click_count INTEGER NOT NULL DEFAULT 0,
    last_clicked_at TEXT,
    -- Server-only: stable id for the link-click history endpoint.
    id TEXT,
    PRIMARY KEY (node_id, target_id)
);

CREATE TABLE IF NOT EXISTS node_public_share (
    node_id TEXT PRIMARY KEY,
    slug TEXT,
    password_hash TEXT,
    created_at TEXT,
    created_by TEXT,
    -- Server-only extras preserved for the share API.
    share_id TEXT,
    workspace_id TEXT,
    expiry_date TEXT
);

CREATE INDEX IF NOT EXISTS idx_node_public_share_node
    ON node_public_share (node_id);

CREATE INDEX IF NOT EXISTS idx_node_public_share_share
    ON node_public_share (share_id);

CREATE TABLE IF NOT EXISTS node_user_share (
    node_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT,
    created_by TEXT,
    -- Server-only extras preserved for the share API.
    share_id TEXT,
    target_user_id TEXT,
    permission_bits INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (node_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_node_user_share_user
    ON node_user_share (user_id);

CREATE INDEX IF NOT EXISTS idx_node_user_share_share
    ON node_user_share (share_id);

CREATE TABLE IF NOT EXISTS plugin_op_log (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    op_id TEXT NOT NULL UNIQUE,
    plugin_id TEXT NOT NULL,
    op_type TEXT,
    data TEXT,
    actor_id TEXT,
    recorded_at TEXT,
    -- Server-only extras preserved for plugin appliers.
    node_id TEXT,
    data_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_plugin_op_log_plugin
    ON plugin_op_log (plugin_id);

CREATE TABLE IF NOT EXISTS node_alias (
    alias_node_id TEXT PRIMARY KEY,
    canonical_node_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_node_alias_canonical
    ON node_alias (canonical_node_id);

CREATE TABLE IF NOT EXISTS node_version (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    content TEXT NOT NULL,
    actor_id TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_node_version_node
    ON node_version (node_id, created_at DESC);

CREATE TABLE IF NOT EXISTS node_view (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    name TEXT NOT NULL,
    view_type TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    shown_properties TEXT NOT NULL DEFAULT '[]',
    group_by TEXT,
    view_mode TEXT,
    sort_entries TEXT NOT NULL DEFAULT '[]',
    settings TEXT NOT NULL DEFAULT '{}',
    query_ast TEXT,
    created_at TEXT,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_node_view_node
    ON node_view (node_id);

CREATE INDEX IF NOT EXISTS idx_node_view_node_type
    ON node_view (node_id, view_type);

CREATE INDEX IF NOT EXISTS idx_node_view_node_order
    ON node_view (node_id, view_type, order_index);

CREATE TABLE IF NOT EXISTS user_favorite (
    actor_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (actor_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_user_favorite_actor
    ON user_favorite (actor_id, workspace_id);

-- Server-only derived tables (not present in the frontend schema).

CREATE TABLE IF NOT EXISTS flashcard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL UNIQUE,
    node_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    front_text TEXT NOT NULL DEFAULT '',
    back_text TEXT NOT NULL DEFAULT '',
    ease_factor REAL NOT NULL DEFAULT 2.5,
    interval_days INTEGER NOT NULL DEFAULT 0,
    repetitions INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    due_date TEXT,
    last_reviewed_at TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_flashcard_workspace_actor
    ON flashcard (workspace_id, actor_id);
CREATE INDEX IF NOT EXISTS idx_flashcard_due
    ON flashcard (workspace_id, actor_id, due_date)
    WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_flashcard_node
    ON flashcard (node_id);

-- Trash retention tracking. The operation log hard-deletes nodes immediately,
-- so the derived node table has no soft-delete concept. This table records the
-- deletion timestamp (and asset metadata needed for file cleanup) so the
-- retention scheduler can purge old deletions and their associated files.
CREATE TABLE IF NOT EXISTS trash (
    node_id TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL,
    is_asset INTEGER NOT NULL DEFAULT 0,
    asset_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_trash_deleted_at
    ON trash (deleted_at);
"""


def create_derived_schema(conn: sqlite3.Connection) -> None:
    """Create the derived-state tables in ``conn``."""
    conn.executescript(SCHEMA_SQL)
    conn.commit()
