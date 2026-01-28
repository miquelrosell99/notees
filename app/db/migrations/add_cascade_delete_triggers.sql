-- Migration: Add cascade delete triggers for critical relationships
-- Date: 2026-01-28
-- Phase: 1 - Service Hardening

-- Node Links: Cascade delete when source or target node is deleted
-- This is already handled by ON DELETE CASCADE in the schema, but we verify it here

-- Ensure node_link has proper cascade behavior
ALTER TABLE node_link DROP CONSTRAINT IF EXISTS node_link_source_id_fkey;
ALTER TABLE node_link DROP CONSTRAINT IF EXISTS node_link_target_id_fkey;

ALTER TABLE node_link
ADD CONSTRAINT node_link_source_id_fkey 
FOREIGN KEY (source_id) REFERENCES node(id) ON DELETE CASCADE;

ALTER TABLE node_link
ADD CONSTRAINT node_link_target_id_fkey
FOREIGN KEY (target_id) REFERENCES node(id) ON DELETE CASCADE;

-- Ensure class_inline has proper cascade behavior
ALTER TABLE class_inline DROP CONSTRAINT IF EXISTS class_inline_node_id_fkey;
ALTER TABLE class_inline DROP CONSTRAINT IF EXISTS class_inline_class_id_fkey;

ALTER TABLE class_inline
ADD CONSTRAINT class_inline_node_id_fkey
FOREIGN KEY (node_id) REFERENCES node(id) ON DELETE CASCADE;

ALTER TABLE class_inline
ADD CONSTRAINT class_inline_class_id_fkey
FOREIGN KEY (class_id) REFERENCES node(id) ON DELETE CASCADE;

-- Ensure node_property has proper cascade behavior
ALTER TABLE node_property DROP CONSTRAINT IF EXISTS node_property_node_id_fkey;
ALTER TABLE node_property DROP CONSTRAINT IF EXISTS node_property_property_id_fkey;

ALTER TABLE node_property
ADD CONSTRAINT node_property_node_id_fkey
FOREIGN KEY (node_id) REFERENCES node(id) ON DELETE CASCADE;

ALTER TABLE node_property
ADD CONSTRAINT node_property_property_id_fkey
FOREIGN KEY (property_id) REFERENCES property(id) ON DELETE CASCADE;

-- Ensure property value tables have proper cascade behavior
ALTER TABLE property_value_scalar DROP CONSTRAINT IF EXISTS property_value_scalar_node_id_fkey;
ALTER TABLE property_value_scalar DROP CONSTRAINT IF EXISTS property_value_scalar_node_property_id_fkey;

ALTER TABLE property_value_scalar
ADD CONSTRAINT property_value_scalar_node_id_fkey
FOREIGN KEY (node_id) REFERENCES node(id) ON DELETE CASCADE;

ALTER TABLE property_value_scalar
ADD CONSTRAINT property_value_scalar_node_property_id_fkey
FOREIGN KEY (node_property_id) REFERENCES node_property(id) ON DELETE CASCADE;

ALTER TABLE property_value_relation DROP CONSTRAINT IF EXISTS property_value_relation_node_id_fkey;
ALTER TABLE property_value_relation DROP CONSTRAINT IF EXISTS property_value_relation_node_property_id_fkey;
ALTER TABLE property_value_relation DROP CONSTRAINT IF EXISTS property_value_relation_target_id_fkey;

ALTER TABLE property_value_relation
ADD CONSTRAINT property_value_relation_node_id_fkey
FOREIGN KEY (node_id) REFERENCES node(id) ON DELETE CASCADE;

ALTER TABLE property_value_relation
ADD CONSTRAINT property_value_relation_node_property_id_fkey
FOREIGN KEY (node_property_id) REFERENCES node_property(id) ON DELETE CASCADE;

ALTER TABLE property_value_relation
ADD CONSTRAINT property_value_relation_target_id_fkey
FOREIGN KEY (target_id) REFERENCES node(id) ON DELETE CASCADE;

ALTER TABLE property_value_selection DROP CONSTRAINT IF EXISTS property_value_selection_node_id_fkey;
ALTER TABLE property_value_selection DROP CONSTRAINT IF EXISTS property_value_selection_node_property_id_fkey;

ALTER TABLE property_value_selection
ADD CONSTRAINT property_value_selection_node_id_fkey
FOREIGN KEY (node_id) REFERENCES node(id) ON DELETE CASCADE;

ALTER TABLE property_value_selection
ADD CONSTRAINT property_value_selection_node_property_id_fkey
FOREIGN KEY (node_property_id) REFERENCES node_property(id) ON DELETE CASCADE;

-- Ensure node_view tables have proper cascade behavior
ALTER TABLE node_view DROP CONSTRAINT IF EXISTS node_view_node_id_fkey;

ALTER TABLE node_view
ADD CONSTRAINT node_view_node_id_fkey
FOREIGN KEY (node_id) REFERENCES node(id) ON DELETE CASCADE;

ALTER TABLE node_view_column DROP CONSTRAINT IF EXISTS node_view_column_view_id_fkey;

ALTER TABLE node_view_column
ADD CONSTRAINT node_view_column_view_id_fkey
FOREIGN KEY (view_id) REFERENCES node_view(id) ON DELETE CASCADE;

ALTER TABLE node_view_sort DROP CONSTRAINT IF EXISTS node_view_sort_view_id_fkey;

ALTER TABLE node_view_sort
ADD CONSTRAINT node_view_sort_view_id_fkey
FOREIGN KEY (view_id) REFERENCES node_view(id) ON DELETE CASCADE;

ALTER TABLE node_view_filter DROP CONSTRAINT IF EXISTS node_view_filter_view_id_fkey;

ALTER TABLE node_view_filter
ADD CONSTRAINT node_view_filter_view_id_fkey
FOREIGN KEY (view_id) REFERENCES node_view(id) ON DELETE CASCADE;

-- Comments: Ensure comments cascade delete when parent node is deleted
-- (Already handled by node parent_id relationship)

-- Add index on deleted nodes to exclude from closure table updates
CREATE INDEX IF NOT EXISTS idx_node_active_not_deleted ON node(id) WHERE active = TRUE AND is_deleted = FALSE;

-- Note: The node_path closure table should already cascade properly via triggers
-- defined in the schema. This migration ensures all foreign keys are explicit.
