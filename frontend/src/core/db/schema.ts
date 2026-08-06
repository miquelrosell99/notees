import { type Database } from 'sql.js';
import { rebuildNodeStats } from '../derived/nodeStats';
import { extractPlaintext } from '../derived/search';

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
      kind TEXT NOT NULL CHECK (kind IN ('page', 'block')),
      class_ids TEXT NOT NULL DEFAULT '[]',
      parent_id TEXT,
      content TEXT NOT NULL DEFAULT '[]',
      icon TEXT,
      color TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT,
      updated_at TEXT,
      created_by TEXT,
      updated_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_node_workspace
    ON node (workspace_id);

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

    CREATE INDEX IF NOT EXISTS idx_edge_source_type
    ON edge (source_id, type);

    CREATE INDEX IF NOT EXISTS idx_edge_target_type
    ON edge (target_id, type);

    CREATE TABLE IF NOT EXISTS node_link (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT,
      click_count INTEGER NOT NULL DEFAULT 0,
      last_navigated_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_node_link_source
    ON node_link (source_id);

    CREATE INDEX IF NOT EXISTS idx_node_link_target
    ON node_link (target_id);

    CREATE INDEX IF NOT EXISTS idx_node_link_source_target
    ON node_link (source_id, target_id);

    CREATE TABLE IF NOT EXISTS crdt_state (
      node_id TEXT PRIMARY KEY,
      text_state BLOB,
      tree_state BLOB
    );

    -- sql.js ships with the FTS4 extension, which is sufficient for ranked
    -- full-text search. If we ever switch to a custom SQLite build with FTS5,
    -- only this schema statement and the ranking formula need to change.
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

    CREATE TABLE IF NOT EXISTS sync_outbox (
      operation_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      last_error TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sync_outbox_state
    ON sync_outbox (state);

    CREATE TABLE IF NOT EXISTS node_stats (
      node_id TEXT PRIMARY KEY,
      child_count INTEGER NOT NULL DEFAULT 0,
      backlink_count INTEGER NOT NULL DEFAULT 0,
      reference_count INTEGER NOT NULL DEFAULT 0,
      descendant_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
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
  `);

  migrateSchema(db);
}

/**
 * Lightweight schema migrations for existing client-side SQLite databases.
 *
 * The operation-log core ships inside the browser, so older IndexedDB snapshots
 * may be missing columns added after the initial release. PRAGMA user_version
 * tracks which migrations have already run.
 */
function migrateSchema(db: Database): void {
  const versionRow = db.exec('PRAGMA user_version')[0];
  const version = versionRow?.values[0]?.[0] as number | undefined ?? 0;

  if (version < 1) {
    try {
      db.exec('ALTER TABLE node ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
    } catch {
      // Column may already exist in some states; ignore and continue.
    }
    db.exec('PRAGMA user_version = 1');
  }

  if (version < 2) {
    // Migrate the legacy plain search_index table to an FTS4 virtual table.
    const master = db.exec(
      "SELECT sql FROM sqlite_master WHERE name = 'search_index' AND type = 'table'",
    );
    const sql = master[0]?.values[0]?.[0] as string | undefined;
    if (sql && !sql.toUpperCase().startsWith('CREATE VIRTUAL TABLE')) {
      db.exec('DROP TABLE search_index');
      db.exec(
        'CREATE VIRTUAL TABLE search_index USING fts4(node_id, content, notindexed=node_id, tokenize=unicode61)',
      );
      const rows = db.exec('SELECT id, content FROM node WHERE active = 1');
      if (rows[0]?.values) {
        for (const row of rows[0].values) {
          const [nodeId, contentJson] = row as [string, string];
          const content = JSON.parse(contentJson) as unknown[];
          const plaintext = extractPlaintext(content);
          if (plaintext.length > 0) {
            db.run('INSERT INTO search_index (node_id, content) VALUES (?, ?)', [
              nodeId,
              plaintext,
            ]);
          }
        }
      }
    }
    db.exec('PRAGMA user_version = 2');
  }

  if (version < 3) {
    // Add property schema and class-property edge tables.
    db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_property_schema_workspace ON property_schema (workspace_id);
      CREATE INDEX IF NOT EXISTS idx_property_schema_node ON property_schema (node_id);

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
      CREATE INDEX IF NOT EXISTS idx_class_property_edge_class ON class_property_edge (class_id);
      CREATE INDEX IF NOT EXISTS idx_class_property_edge_property ON class_property_edge (property_schema_id);
    `);
    db.exec('PRAGMA user_version = 3');
  }

  if (version < 4) {
    db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_node_view_node ON node_view (node_id);
      CREATE INDEX IF NOT EXISTS idx_node_view_node_type ON node_view (node_id, view_type);
      CREATE INDEX IF NOT EXISTS idx_node_view_node_order ON node_view (node_id, view_type, order_index);
    `);
    db.exec('PRAGMA user_version = 4');
  }

  if (version < 5) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_favorite (
        actor_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (actor_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_favorite_actor ON user_favorite (actor_id, workspace_id);
    `);
    db.exec('PRAGMA user_version = 5');
  }

  if (version < 6) {
    try {
      db.exec('ALTER TABLE sync_watermark ADD COLUMN restore_epoch INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column may already exist in some states; ignore and continue.
    }
    db.exec('PRAGMA user_version = 6');
  }

  if (version < 7) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.exec('PRAGMA user_version = 7');
  }

  if (version < 8) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_edge_source_type ON edge (source_id, type);
      CREATE INDEX IF NOT EXISTS idx_edge_target_type ON edge (target_id, type);
    `);
    db.exec('PRAGMA user_version = 8');
  }

  if (version < 9) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_stats (
        node_id TEXT PRIMARY KEY,
        child_count INTEGER NOT NULL DEFAULT 0,
        backlink_count INTEGER NOT NULL DEFAULT 0,
        reference_count INTEGER NOT NULL DEFAULT 0,
        descendant_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT
      );
    `);
    rebuildNodeStats(db);
    db.exec('PRAGMA user_version = 9');
  }

  if (version < 10) {
    try {
      db.exec(`ALTER TABLE sync_outbox ADD COLUMN next_retry_at INTEGER`);
    } catch {
      // Column may already exist; ignore.
    }
    db.exec('PRAGMA user_version = 10');
  }

  if (version < 11) {
    // Enforce PRIMARY KEY (parent_id, child_id) on node_child_order. Older
    // databases were created before the PK was added and could accumulate
    // duplicate rows from corrupt tree CRDT state.
    const master = db.exec(
      "SELECT sql FROM sqlite_master WHERE name = 'node_child_order' AND type = 'table'",
    );
    const createSql = (master[0]?.values[0]?.[0] as string | undefined) ?? '';
    if (createSql && !createSql.toUpperCase().includes('PRIMARY KEY')) {
      db.exec(`
        CREATE TABLE node_child_order_new (
          parent_id TEXT NOT NULL,
          child_id TEXT NOT NULL,
          position TEXT NOT NULL,
          PRIMARY KEY (parent_id, child_id)
        );
        INSERT OR IGNORE INTO node_child_order_new (parent_id, child_id, position)
        SELECT parent_id, child_id, MIN(position)
        FROM node_child_order
        GROUP BY parent_id, child_id;
        DROP TABLE node_child_order;
        ALTER TABLE node_child_order_new RENAME TO node_child_order;
        CREATE INDEX IF NOT EXISTS idx_node_child_order_parent
        ON node_child_order (parent_id);
      `);
    } else {
      // Table already has the PK; still defensively deduplicate in case the
      // constraint was added after duplicates already existed.
      db.exec(`
        DELETE FROM node_child_order
        WHERE rowid NOT IN (
          SELECT MIN(rowid)
          FROM node_child_order
          GROUP BY parent_id, child_id
        );
      `);
    }
    db.exec('PRAGMA user_version = 11');
  }

  if (version < 12) {
    // The legacy search extractor only indexed top-level {type:'text'} nodes,
    // missing headings, links, code, math and whiteboard text. Rebuild the
    // FTS index with the canonical AST stringifier and add the workspace_id
    // index that the search query needs for an efficient join.
    db.exec('BEGIN TRANSACTION');
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_node_workspace ON node (workspace_id)');
      db.exec('DELETE FROM search_index');
      const rows = db.exec('SELECT id, content FROM node WHERE active = 1');
      if (rows[0]?.values) {
        for (const row of rows[0].values) {
          const [nodeId, contentJson] = row as [string, string];
          const content = JSON.parse(contentJson) as unknown[];
          const plaintext = extractPlaintext(content);
          if (plaintext.length > 0) {
            db.run('INSERT INTO search_index (node_id, content) VALUES (?, ?)', [
              nodeId,
              plaintext,
            ]);
          }
        }
      }
      db.exec('COMMIT');
      db.exec('PRAGMA user_version = 12');
    } catch {
      db.exec('ROLLBACK');
      // Leave user_version at 11 so the migration retries on next startup.
    }
  }

  if (version < 13) {
    // Add per-node icon and color so the UI can persist explicit overrides
    // and fall back to inherited class values via getEffectiveIcon.
    try {
      db.exec('ALTER TABLE node ADD COLUMN icon TEXT');
    } catch {
      // Column may already exist; ignore.
    }
    try {
      db.exec('ALTER TABLE node ADD COLUMN color TEXT');
    } catch {
      // Column may already exist; ignore.
    }
    db.exec('PRAGMA user_version = 13');
  }

  if (version < 14) {
    // Add the node_link instance registry. The table definition is also
    // created by createSchema via CREATE TABLE IF NOT EXISTS; this migration
    // ensures existing databases bump their version and trigger a derived-state
    // rebuild via CURRENT_DERIVED_STATE_VERSION in the workspace store.
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_link (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL,
        label TEXT,
        click_count INTEGER NOT NULL DEFAULT 0,
        last_navigated_at TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_node_link_source ON node_link (source_id);
      CREATE INDEX IF NOT EXISTS idx_node_link_target ON node_link (target_id);
      CREATE INDEX IF NOT EXISTS idx_node_link_source_target ON node_link (source_id, target_id);
    `);
    db.exec('PRAGMA user_version = 14');
  }
}
