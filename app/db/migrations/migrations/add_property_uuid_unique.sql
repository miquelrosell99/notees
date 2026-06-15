-- Migration: Make all properties per-workspace (remove global properties)
-- System properties are now per-workspace instead of global

-- Drop old indexes
DROP INDEX IF EXISTS idx_property_uuid;
DROP INDEX IF EXISTS idx_property_uuid_per_workspace;
DROP INDEX IF EXISTS idx_property_name_global;
DROP INDEX IF EXISTS idx_property_workspace_id_uuid;

-- Make workspace_id NOT NULL (first update any NULL values if they exist)
UPDATE property SET workspace_id = 1 WHERE workspace_id IS NULL;

-- Alter column to NOT NULL
ALTER TABLE property ALTER COLUMN workspace_id SET NOT NULL;

-- Add unique constraint on (workspace_id, uuid)
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_workspace_uuid ON property(workspace_id, uuid);

-- Update the workspace-level unique name constraint (remove the workspace_id IS NOT NULL condition)
DROP INDEX IF EXISTS idx_property_name_workspace;
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_workspace ON property(name, workspace_id) 
    WHERE is_local = FALSE AND active = TRUE;
