-- Migration: Update query block types from old names to new names
-- ANCESTOR_PATH -> PARENT_PATH
-- TYPE -> CLASS

-- Update all node_view with the old block types
UPDATE node_view
SET query_json = replace(
    replace(
        query_json::text,
        '"type": "ANCESTOR_PATH"',
        '"type": "PARENT_PATH"'
    ),
    '"type": "TYPE"',
    '"type": "CLASS"'
)::jsonb
WHERE query_json::text LIKE '%ANCESTOR_PATH%'
   OR query_json::text LIKE '%"TYPE"%';

-- Log the changes
DO $$
DECLARE
    updated_count INTEGER;
BEGIN
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RAISE NOTICE 'Updated % node_view rows with old query block types', updated_count;
END $$;
