-- Migration: Add class_ids column to node table
-- Purpose: Move from property_value_relation storage to direct column for better performance
-- Date: 2026-01-29

-- Add class_ids column to node table
ALTER TABLE node ADD COLUMN IF NOT EXISTS class_ids INTEGER[] DEFAULT '{}';

-- Create GIN index for fast array queries
CREATE INDEX IF NOT EXISTS idx_node_class_ids ON node USING GIN (class_ids);

-- Migrate existing data from property_value_relation to class_ids
-- This preserves the order of classes as stored in the "order" column
UPDATE node n SET class_ids = COALESCE((
    SELECT array_agg(pvr.target_id ORDER BY pvr."order")
    FROM property_value_relation pvr
    JOIN property p ON pvr.property_id = p.id
    WHERE pvr.node_id = n.id 
      AND p.name = 'classes'
      AND p.workspace_id = n.workspace_id
      AND pvr.target_id IS NOT NULL
), '{}');

-- Verify migration
-- SELECT 
--     n.id, 
--     n.name, 
--     n.class_ids as new_class_ids,
--     array_agg(pvr.target_id ORDER BY pvr."order") as old_class_ids
-- FROM node n
-- LEFT JOIN property_value_relation pvr ON n.id = pvr.node_id
-- LEFT JOIN property p ON pvr.property_id = p.id AND p.name = 'classes'
-- GROUP BY n.id, n.name, n.class_ids
-- HAVING n.class_ids != COALESCE(array_agg(pvr.target_id ORDER BY pvr."order") FILTER (WHERE pvr.target_id IS NOT NULL), '{}');
