-- Fix node name uniqueness to be per primary class, not just per parent
-- This allows pages with the same name if they have different primary classes
-- Example: "EXAMPLE PAGE" classed as ["task", "meeting"] and "EXAMPLE PAGE" classed as ["project", "meeting"] are OK
-- But "EXAMPLE PAGE" classed as ["task"] cannot coexist with "EXAMPLE PAGE" classed as ["task", "meeting"]
-- Blocks have no name uniqueness constraints

-- Add primary_class_id column to store the first class
ALTER TABLE node ADD COLUMN IF NOT EXISTS primary_class_id INTEGER REFERENCES node(id) ON DELETE SET NULL;

-- Create index for primary_class_id
CREATE INDEX IF NOT EXISTS idx_node_primary_class_id ON node(primary_class_id) WHERE primary_class_id IS NOT NULL;

-- Populate primary_class_id from class_inline table (first class by position)
UPDATE node SET primary_class_id = (
    SELECT class_id FROM class_inline 
    WHERE class_inline.node_id = node.id 
    ORDER BY position 
    LIMIT 1
) WHERE EXISTS (
    SELECT 1 FROM class_inline WHERE class_inline.node_id = node.id
);

-- Drop the old constraint
DROP INDEX IF EXISTS idx_node_page_unique;

-- Create new constraint including primary class
-- COALESCE with 0 treats unclassed pages as having class_id=0 for uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_page_unique ON node(graph_id, parent_id, name, COALESCE(primary_class_id, 0)) 
    WHERE is_page = TRUE AND active = TRUE;
