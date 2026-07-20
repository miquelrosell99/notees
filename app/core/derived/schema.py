"""Derived-state SQLite schema for the Notees operation log.

The schema mirrors ``frontend/src/core/db/schema.ts`` but keeps the tables
needed for backend migration, query compilation, and feature-island ports.
All JSON-like columns are stored as TEXT so the schema works with the standard
``sqlite3`` module.
"""

from __future__ import annotations

import sqlite3

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS node (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('page', 'block', 'class')),
    class_ids TEXT NOT NULL DEFAULT '[]',
    parent_id TEXT,
    content TEXT NOT NULL DEFAULT '[]',
    created_at TEXT,
    updated_at TEXT,
    created_by TEXT,
    updated_by TEXT,
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

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts4(
    node_id,
    content,
    notindexed=node_id,
    tokenize=unicode61
);

CREATE TABLE IF NOT EXISTS crdt_state (
    node_id TEXT PRIMARY KEY,
    text_state BLOB,
    tree_state BLOB
);

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

-- Feature-island derived tables

CREATE TABLE IF NOT EXISTS node_asset (
    node_id TEXT PRIMARY KEY,
    asset_hash TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    original_name TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_node_asset_hash ON node_asset (asset_hash);

CREATE TABLE IF NOT EXISTS task_completion (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    scheduled_date TEXT,
    deadline_date TEXT,
    status TEXT NOT NULL DEFAULT 'done'
);

CREATE INDEX IF NOT EXISTS idx_task_completion_node
    ON task_completion (node_id);

CREATE TABLE IF NOT EXISTS task_recurrence (
    id TEXT,
    node_id TEXT PRIMARY KEY,
    rule_json TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_node_id TEXT,
    details TEXT,
    actor_id TEXT NOT NULL,
    hlc_physical INTEGER NOT NULL,
    hlc_logical INTEGER NOT NULL,
    timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_log_node
    ON activity_log (node_id);

CREATE TABLE IF NOT EXISTS link_click (
    id TEXT PRIMARY KEY,
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    last_clicked_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_link_click_pair
    ON link_click (source_node_id, target_node_id);

CREATE INDEX IF NOT EXISTS idx_link_click_source
    ON link_click (source_node_id);

CREATE TABLE IF NOT EXISTS node_public_share (
    share_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    slug TEXT,
    password_hash TEXT,
    expiry_date TEXT,
    created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_node_public_share_node
    ON node_public_share (node_id);

CREATE TABLE IF NOT EXISTS node_user_share (
    share_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    target_user_id TEXT NOT NULL,
    permission_bits INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_node_user_share_pair
    ON node_user_share (node_id, target_user_id);

CREATE INDEX IF NOT EXISTS idx_node_user_share_node
    ON node_user_share (node_id);

CREATE TABLE IF NOT EXISTS plugin_op_log (
    id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL,
    op_type TEXT NOT NULL,
    node_id TEXT,
    data_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_op_log_plugin
    ON plugin_op_log (plugin_id);
"""


def create_derived_schema(conn: sqlite3.Connection) -> None:
    """Create the derived-state tables in ``conn``."""
    conn.executescript(SCHEMA_SQL)
    conn.commit()
