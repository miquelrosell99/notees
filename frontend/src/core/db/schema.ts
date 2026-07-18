import { type Database } from 'sql.js';

export function createSchema(db: Database): void {
  db.exec(`
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
      created_at TEXT,
      updated_at TEXT,
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS node_child_order (
      parent_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      position TEXT NOT NULL,
      PRIMARY KEY (parent_id, child_id)
    );

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

    CREATE TABLE IF NOT EXISTS crdt_state (
      node_id TEXT PRIMARY KEY,
      text_state BLOB,
      tree_state BLOB
    );

    -- sql.js is compiled without the FTS5 extension, so we use a plain table
    -- here. A production build that links a full SQLite can switch this back to
    -- a CREATE VIRTUAL TABLE ... USING fts5 statement without changing callers.
    CREATE TABLE IF NOT EXISTS class_hierarchy (
      class_id TEXT NOT NULL,
      ancestor_id TEXT NOT NULL,
      PRIMARY KEY (class_id, ancestor_id)
    );

    CREATE INDEX IF NOT EXISTS idx_class_hierarchy_ancestor
    ON class_hierarchy (ancestor_id);

    CREATE TABLE IF NOT EXISTS search_index (
      node_id TEXT PRIMARY KEY,
      content TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_watermark (
      workspace_id TEXT PRIMARY KEY,
      hlc_physical INTEGER NOT NULL,
      hlc_logical INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_asset (
      node_id TEXT NOT NULL,
      asset_hash TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      original_name TEXT NOT NULL DEFAULT '',
      uploaded_at TEXT,
      PRIMARY KEY (node_id, asset_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_node_asset_hash
    ON node_asset (asset_hash);

    CREATE TABLE IF NOT EXISTS task_completion (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      completed_at TEXT,
      actor_id TEXT,
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_task_completion_node
    ON task_completion (node_id);

    CREATE TABLE IF NOT EXISTS task_recurrence (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      rule TEXT NOT NULL,
      actor_id TEXT,
      created_at TEXT
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
      recorded_at TEXT
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
      PRIMARY KEY (node_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS node_public_share (
      node_id TEXT PRIMARY KEY,
      slug TEXT,
      password_hash TEXT,
      created_at TEXT,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS node_user_share (
      node_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT,
      created_by TEXT,
      PRIMARY KEY (node_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS plugin_op_log (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      op_id TEXT NOT NULL UNIQUE,
      plugin_id TEXT NOT NULL,
      op_type TEXT,
      data TEXT,
      actor_id TEXT,
      recorded_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_plugin_op_log_plugin
    ON plugin_op_log (plugin_id);
  `);
}
