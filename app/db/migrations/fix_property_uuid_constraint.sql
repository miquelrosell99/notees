-- Fix property UUID constraint to be per-graph instead of global
-- This allows system properties (like built-in property definitions) 
-- to exist with the same UUID in multiple graphs

-- Drop the global unique constraint on property.uuid
ALTER TABLE property DROP CONSTRAINT IF EXISTS property_uuid_key;

-- Add per-graph unique constraint (graph_id, uuid)
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_uuid_per_graph ON property(graph_id, uuid);
