-- Migration: Make all properties per-graph (remove global properties)
-- System properties are now per-graph instead of global

-- Drop old indexes
DROP INDEX IF EXISTS idx_property_uuid;
DROP INDEX IF EXISTS idx_property_uuid_per_graph;
DROP INDEX IF EXISTS idx_property_name_global;
DROP INDEX IF EXISTS idx_property_graph_id_uuid;

-- Make graph_id NOT NULL (first update any NULL values if they exist)
UPDATE property SET graph_id = 1 WHERE graph_id IS NULL;

-- Alter column to NOT NULL
ALTER TABLE property ALTER COLUMN graph_id SET NOT NULL;

-- Add unique constraint on (graph_id, uuid)
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_graph_uuid ON property(graph_id, uuid);

-- Update the graph-level unique name constraint (remove the graph_id IS NOT NULL condition)
DROP INDEX IF EXISTS idx_property_name_graph;
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_graph ON property(name, graph_id) 
    WHERE is_local = FALSE AND active = TRUE;
