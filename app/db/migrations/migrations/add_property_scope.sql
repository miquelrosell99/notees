-- Migration: Add scope column to property table
-- Replaces boolean is_local with a tri-state scope: 'global' | 'class' | 'node'
-- 
-- 'global' - workspace-wide property (was is_local=FALSE)
-- 'class'  - scoped to a class node, inherited by instances via class_property
-- 'node'   - scoped to a specific node only (was is_local=TRUE)

-- Add the scope column with a default matching the old default
ALTER TABLE property ADD COLUMN IF NOT EXISTS scope VARCHAR(20) NOT NULL DEFAULT 'global';

-- Migrate existing data
UPDATE property SET scope = 'node' WHERE is_local = TRUE;
UPDATE property SET scope = 'global' WHERE is_local = FALSE;

-- Drop old unique indexes that used is_local
DROP INDEX IF EXISTS idx_property_name_workspace;
DROP INDEX IF EXISTS idx_property_name_local;

-- New unique indexes using scope
-- Global properties: unique name per workspace
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_global ON property(name, workspace_id)
    WHERE scope = 'global' AND active = TRUE;

-- Scoped properties (class or node): unique name per node_id+scope
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_scoped ON property(name, node_id, scope)
    WHERE scope != 'global' AND active = TRUE;

-- Update CHECK constraint (drop old, add new)
ALTER TABLE property DROP CONSTRAINT IF EXISTS property_is_local_node_id_check;
ALTER TABLE property ADD CONSTRAINT property_scope_node_id_check
    CHECK (scope = 'global' OR node_id IS NOT NULL);
