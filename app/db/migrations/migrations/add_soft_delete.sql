-- Migration: Add soft-delete columns to node table
-- Date: 2026-01-28
-- Phase: 0 - Critical / P0 Actions

-- Add soft-delete columns to node table
ALTER TABLE node 
ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Create index on is_deleted for efficient trash queries
CREATE INDEX IF NOT EXISTS idx_node_is_deleted ON node(is_deleted) WHERE is_deleted = TRUE;

-- Update existing active flag logic to exclude deleted nodes
-- NOTE: Application code should filter by both active=TRUE AND is_deleted=FALSE
-- The active flag is kept for backward compatibility but soft-delete takes precedence
