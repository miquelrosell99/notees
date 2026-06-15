-- Migration: Drop redundant is_local column from property table
-- scope VARCHAR(20) fully supersedes is_local BOOLEAN.
-- 'global'  = old is_local=FALSE
-- 'node'    = old is_local=TRUE
-- 'class'   = new scope not representable by boolean

ALTER TABLE property DROP COLUMN IF EXISTS is_local;
