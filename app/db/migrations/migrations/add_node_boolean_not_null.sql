-- Migration: Add NOT NULL constraints to node boolean flags
--
-- Partial indexes (e.g. WHERE active = TRUE AND is_deleted = FALSE) exclude NULL
-- rows, causing silent data loss. These flags should never be NULL.

-- Coalesce any existing NULLs to their defaults
UPDATE node SET collapsed      = FALSE WHERE collapsed IS NULL;
UPDATE node SET active         = TRUE  WHERE active IS NULL;
UPDATE node SET is_shared      = FALSE WHERE is_shared IS NULL;
UPDATE node SET is_deleted     = FALSE WHERE is_deleted IS NULL;
UPDATE node SET is_class       = FALSE WHERE is_class IS NULL;
UPDATE node SET is_page        = FALSE WHERE is_page IS NULL;
UPDATE node SET is_day         = FALSE WHERE is_day IS NULL;
UPDATE node SET is_month       = FALSE WHERE is_month IS NULL;
UPDATE node SET is_year        = FALSE WHERE is_year IS NULL;
UPDATE node SET is_asset       = FALSE WHERE is_asset IS NULL;
UPDATE node SET is_template    = FALSE WHERE is_template IS NULL;
UPDATE node SET is_comment     = FALSE WHERE is_comment IS NULL;
UPDATE node SET parent_locked  = FALSE WHERE parent_locked IS NULL;
UPDATE node SET is_private     = FALSE WHERE is_private IS NULL;

-- Add NOT NULL constraints
ALTER TABLE node ALTER COLUMN collapsed     SET NOT NULL;
ALTER TABLE node ALTER COLUMN active        SET NOT NULL;
ALTER TABLE node ALTER COLUMN is_shared     SET NOT NULL;
ALTER TABLE node ALTER COLUMN is_deleted    SET NOT NULL;
ALTER TABLE node ALTER COLUMN is_class      SET NOT NULL;
ALTER TABLE node ALTER COLUMN is_page       SET NOT NULL;
ALTER TABLE node ALTER COLUMN is_day        SET NOT NULL;
ALTER TABLE node ALTER COLUMN is_month      SET NOT NULL;
ALTER TABLE node ALTER COLUMN is_year       SET NOT NULL;
ALTER TABLE node ALTER COLUMN is_asset      SET NOT NULL;
ALTER TABLE node ALTER COLUMN is_template   SET NOT NULL;
ALTER TABLE node ALTER COLUMN is_comment    SET NOT NULL;
ALTER TABLE node ALTER COLUMN parent_locked SET NOT NULL;
ALTER TABLE node ALTER COLUMN is_private    SET NOT NULL;
