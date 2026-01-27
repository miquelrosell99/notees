-- Migration to add shown_properties and group_by columns to node_view table
-- Run this against your existing database

ALTER TABLE node_view 
ADD COLUMN IF NOT EXISTS shown_properties JSONB DEFAULT '[]'::jsonb;

ALTER TABLE node_view 
ADD COLUMN IF NOT EXISTS group_by TEXT DEFAULT NULL;

COMMENT ON COLUMN node_view.shown_properties IS 'Array of {uuid: string, sequence: number} for table view columns';
COMMENT ON COLUMN node_view.group_by IS 'Group by field for card view (e.g., page, type, property uuid)';
