-- Migration: Fix node UUID constraint to be per-graph instead of global
-- Date: 2026-01-27
-- Description: Changes the UNIQUE constraint on node.uuid to allow the same UUID 
--              to exist in different graphs (UUID should be unique per graph, not globally)

-- Drop the global unique constraint on uuid
ALTER TABLE node DROP CONSTRAINT IF EXISTS node_uuid_key;

-- Create a compound unique constraint on (graph_id, uuid)
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_uuid_per_graph ON node(graph_id, uuid);
