-- Migration: Add undo_log table for global undo/redo support
-- Date: 2026-03-23

CREATE TABLE IF NOT EXISTS undo_log (
    id          BIGSERIAL PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL,
    operation   TEXT NOT NULL,           -- 'update_node', 'move_node', 'delete_node', 'add_class', 'remove_class', 'set_property', 'remove_property', 'create_node', 'archive_node', 'unarchive_node'
    entity_type TEXT NOT NULL,           -- 'node', 'property_value', 'class'
    entity_id   INTEGER NOT NULL,        -- Primary entity ID (node_id)
    before_state JSONB,                  -- Snapshot before the operation (NULL for create)
    after_state  JSONB,                  -- Snapshot after the operation (NULL for delete)
    description  TEXT,                   -- Human-readable label, e.g. "Renamed 'Foo' → 'Bar'"
    is_undone    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient undo stack queries (most recent first, per workspace+user)
CREATE INDEX IF NOT EXISTS idx_undo_log_stack
    ON undo_log (workspace_id, user_id, created_at DESC)
    WHERE is_undone = FALSE;

-- Index for redo stack (undone entries, most recent first)
CREATE INDEX IF NOT EXISTS idx_undo_log_redo
    ON undo_log (workspace_id, user_id, created_at DESC)
    WHERE is_undone = TRUE;

-- Trim old entries: only keep last 200 per workspace+user 
-- (application-level enforcement, not a DB constraint)
