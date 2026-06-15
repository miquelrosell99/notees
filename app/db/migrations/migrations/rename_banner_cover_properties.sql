-- Migration: Rename banner and cover properties to Banner and Cover (uppercase)
-- This updates system properties to have uppercase names for consistency

-- Update 'cover' property to 'Cover'
UPDATE property 
SET name = 'Cover' 
WHERE uuid = '00000000-0000-0000-0000-000000000005' 
  AND name = 'cover' 
  AND is_system = TRUE;

-- Update 'banner' property to 'Banner'
UPDATE property 
SET name = 'Banner' 
WHERE uuid = '00000000-0000-0000-0000-000000000006' 
  AND name = 'banner' 
  AND is_system = TRUE;
