-- Migration: Add query_json to node_view table
-- This migration changes the storage of query block trees from a separate query node
-- to a direct JSON column on the node_view table.

-- Step 1: Add the new column with a default value
ALTER TABLE node_view 
ADD COLUMN IF NOT EXISTS query_json JSONB NOT NULL DEFAULT '{"type": "AND_CONTAINER", "blocks": []}'::jsonb;

-- Step 2: Migrate existing data from query nodes to query_json
-- Note: This requires the _query_block_tree property to exist and have data
UPDATE node_view nv
SET query_json = COALESCE(
    (
        SELECT pvs.value_text::jsonb
        FROM property_value_scalar pvs
        JOIN node_property np ON np.id = pvs.node_property_id
        JOIN property p ON p.id = np.property_id
        WHERE pvs.node_id = nv.query_node_id 
          AND p.name = '_query_block_tree'
        LIMIT 1
    ),
    '{"type": "AND_CONTAINER", "blocks": []}'::jsonb
)
WHERE EXISTS (SELECT 1 FROM node WHERE id = nv.query_node_id);

-- Step 3: Drop the query_node_id column (after data migration)
-- WARNING: Only run this after verifying the migration was successful!
-- ALTER TABLE node_view DROP COLUMN query_node_id;

-- Step 4: Drop the index that's no longer needed
DROP INDEX IF EXISTS idx_node_view_query_node_id;

-- Note: The orphaned query nodes can be cleaned up separately if desired.
-- They are nodes with is_page=false and type='query' that are no longer referenced.
