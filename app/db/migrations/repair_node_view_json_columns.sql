-- Migration: Repair node_view JSONB columns stored as strings or old format
--
-- Some imports or older code paths stored shown_properties or query_json
-- as JSON-encoded strings (e.g. '"[]"' instead of []). This migration
-- normalizes them using PostgreSQL's jsonb_typeof().

-- Fix shown_properties that are JSON strings instead of arrays
UPDATE node_view
SET shown_properties = '[]'::jsonb
WHERE jsonb_typeof(shown_properties) = 'string';

-- Fix default views that have old-format or string query_json.
-- Restore the proper system query AST for each view_type.
UPDATE node_view nv
SET query_json = CASE nv.view_type
    WHEN 'child_pages' THEN
        '{"type": "query", "version": "1.0", "scope": {"type": "scope", "scope_type": "pages"}, "root_group": {"type": "group", "logic": "AND", "children": [{"type": "condition", "condition_type": "parent", "parent_uuid": "{current_node_uuid}", "operator": "has_parent"}]}, "is_system": true}'::jsonb
    WHEN 'classed_nodes' THEN
        '{"type": "query", "version": "1.0", "scope": {"type": "scope", "scope_type": "entire_workspace"}, "root_group": {"type": "group", "logic": "AND", "children": [{"type": "condition", "condition_type": "class", "class_uuid": "{current_node_uuid}", "operator": "contains"}]}, "is_system": true}'::jsonb
    WHEN 'extended_by' THEN
        '{"type": "query", "version": "1.0", "scope": {"type": "scope", "scope_type": "entire_workspace"}, "root_group": {"type": "group", "logic": "AND", "children": [{"type": "condition", "condition_type": "extends", "extends_class_uuid": "{current_node_uuid}"}]}, "is_system": true}'::jsonb
    WHEN 'linked_references' THEN
        '{"type": "query", "version": "1.0", "scope": {"type": "scope", "scope_type": "entire_workspace"}, "root_group": {"type": "group", "logic": "AND", "children": [{"type": "condition", "condition_type": "reference", "target_uuid": "{current_node_uuid}"}, {"type": "condition", "condition_type": "page", "page_uuid": "{current_node_uuid}", "operator": "is_not_page"}]}, "is_system": true}'::jsonb
    WHEN 'unlinked_references' THEN
        '{"type": "query", "version": "1.0", "scope": {"type": "scope", "scope_type": "entire_workspace"}, "root_group": {"type": "group", "logic": "AND", "children": [{"type": "condition", "condition_type": "content", "operator": "contains", "value": "{current_node_name}"}, {"type": "condition", "condition_type": "property", "property_name": "uuid", "operator": "not_equals", "value": "{current_node_uuid}"}, {"type": "condition", "condition_type": "class", "class_uuid": "00000000-0000-0000-0001-000000000002", "operator": "does_not_contain"}]}, "is_system": true}'::jsonb
    WHEN 'main_content' THEN
        '{"type": "query", "version": "1.0", "scope": {"type": "scope", "scope_type": "entire_workspace"}, "root_group": {"type": "group", "logic": "AND", "children": []}, "is_system": true}'::jsonb
    ELSE
        '{"type": "query", "version": "1.0", "scope": {"type": "scope", "scope_type": "entire_workspace"}, "root_group": {"type": "group", "logic": "AND", "children": []}}'::jsonb
END
WHERE nv.is_default = TRUE
  AND (jsonb_typeof(nv.query_json) = 'string'
       OR (nv.query_json->>'type') = 'AND_CONTAINER');

-- Fix non-default views that have old-format or string query_json.
-- We can't restore their original intent, so set them to the new empty AST format.
UPDATE node_view
SET query_json = '{"type": "query", "version": "1.0", "scope": {"type": "scope", "scope_type": "entire_workspace"}, "root_group": {"type": "group", "logic": "AND", "children": []}}'::jsonb
WHERE is_default = FALSE
  AND (jsonb_typeof(query_json) = 'string'
       OR (query_json->>'type') = 'AND_CONTAINER');
