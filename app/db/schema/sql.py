"""PostgreSQL DDL schema for Notees.

This module contains the raw SQL schema definition for creating
all database tables, indexes, and triggers.

SCHEMA VERSION: 3 - Class-based architecture (renamed type -> class).

Key changes from v2:
- "type" -> "class" terminology throughout
- Tables renamed: type_property -> class_property, type_extend -> class_extend, type_inline -> class_inline
- Columns renamed: is_type -> is_class, type_node_id -> class_node_id, type_id -> class_id
- property_type_filter -> property_class_filter
"""

SCHEMA_SQL = """
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- CORE IDENTITY & ACCESS
-- ============================================================

-- User table (global, not per workspace)
CREATE TABLE IF NOT EXISTS "user" (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    username VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- WORKSPACES
-- ============================================================

-- Workspace table
CREATE TABLE IF NOT EXISTS workspace (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    active BOOLEAN DEFAULT TRUE,
    is_shared BOOLEAN DEFAULT FALSE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_create_uid ON workspace(create_uid);
CREATE INDEX IF NOT EXISTS idx_workspace_write_uid ON workspace(write_uid);
-- Unique workspace name per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_name_per_user ON workspace(name, create_uid) WHERE active = TRUE;

-- Workspace sharing with granular permissions
CREATE TABLE IF NOT EXISTS workspace_share (
    id SERIAL PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    can_read BOOLEAN DEFAULT TRUE,
    can_write BOOLEAN DEFAULT FALSE,
    can_create BOOLEAN DEFAULT FALSE,
    can_delete BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    UNIQUE(workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_share_workspace_id ON workspace_share(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_share_user_id ON workspace_share(user_id);

-- ============================================================
-- NODES
-- ============================================================

-- Node table - the core entity
CREATE TABLE IF NOT EXISTS node (
    id SERIAL PRIMARY KEY,
    uuid UUID NOT NULL DEFAULT uuid_generate_v4(),
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    icon VARCHAR(100),
    color VARCHAR(50),
    parent_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    page_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    sequence INTEGER DEFAULT 0,
    collapsed BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    is_shared BOOLEAN DEFAULT FALSE,
    version INTEGER DEFAULT 1,
    -- Soft delete fields
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    -- Class flags (denormalized for fast queries)
    is_class BOOLEAN DEFAULT FALSE,
    is_page BOOLEAN DEFAULT FALSE,
    is_day BOOLEAN DEFAULT FALSE,
    is_month BOOLEAN DEFAULT FALSE,
    is_year BOOLEAN DEFAULT FALSE,
    is_asset BOOLEAN DEFAULT FALSE,
    is_template BOOLEAN DEFAULT FALSE,
    is_comment BOOLEAN DEFAULT FALSE,
    -- Class IDs stored directly on the node
    class_ids INTEGER[] DEFAULT '{}',
    classes_path JSONB DEFAULT '[]'::jsonb,
    open_date TIMESTAMPTZ,
    -- Full-text search
    search_vector tsvector,
    search_language VARCHAR(50) DEFAULT 'english',
    -- Audit
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

-- Node indexes
CREATE INDEX IF NOT EXISTS idx_node_workspace_id ON node(workspace_id);
CREATE INDEX IF NOT EXISTS idx_node_uuid ON node(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_uuid_per_workspace ON node(workspace_id, uuid);
CREATE INDEX IF NOT EXISTS idx_node_parent_id ON node(parent_id);
CREATE INDEX IF NOT EXISTS idx_node_page_id ON node(page_id);
CREATE INDEX IF NOT EXISTS idx_node_name ON node(name);
CREATE INDEX IF NOT EXISTS idx_node_is_page ON node(is_page) WHERE is_page = TRUE;
CREATE INDEX IF NOT EXISTS idx_node_is_class ON node(is_class) WHERE is_class = TRUE;
CREATE INDEX IF NOT EXISTS idx_node_is_day ON node(is_day) WHERE is_day = TRUE;
CREATE INDEX IF NOT EXISTS idx_node_open_date ON node(open_date) WHERE open_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_node_is_deleted ON node(is_deleted) WHERE is_deleted = TRUE;
CREATE INDEX IF NOT EXISTS idx_node_class_ids ON node USING GIN (class_ids);
CREATE INDEX IF NOT EXISTS idx_node_classes_path ON node USING GIN (classes_path);
CREATE INDEX IF NOT EXISTS idx_node_search ON node USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_node_create_uid ON node(create_uid);
CREATE INDEX IF NOT EXISTS idx_node_write_uid ON node(write_uid);
-- Note: Page name uniqueness per class is enforced at application level
-- Database only enforces basic structure, complex class-based uniqueness in Python

-- Node sharing with granular permissions
CREATE TABLE IF NOT EXISTS node_share (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    can_read BOOLEAN DEFAULT TRUE,
    can_write BOOLEAN DEFAULT FALSE,
    can_create BOOLEAN DEFAULT FALSE,
    can_delete BOOLEAN DEFAULT FALSE,
    inherited BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    UNIQUE(node_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_node_share_node_id ON node_share(node_id);
CREATE INDEX IF NOT EXISTS idx_node_share_user_id ON node_share(user_id);

-- ============================================================
-- PROPERTIES
-- ============================================================

-- Property definition
CREATE TABLE IF NOT EXISTS property (
    id SERIAL PRIMARY KEY,
    uuid UUID NOT NULL DEFAULT uuid_generate_v4(),
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    icon VARCHAR(100),
    type VARCHAR(50) NOT NULL DEFAULT 'text',
    is_multi BOOLEAN DEFAULT FALSE,
    is_system BOOLEAN DEFAULT FALSE,
    is_local BOOLEAN DEFAULT FALSE,
    node_id INTEGER REFERENCES node(id) ON DELETE CASCADE,
    icon_visibility VARCHAR(50) DEFAULT 'hidden',
    active BOOLEAN DEFAULT TRUE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    CHECK (is_local = FALSE OR node_id IS NOT NULL),
    CHECK (type NOT IN ('text', 'image') OR is_multi = FALSE)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_property_workspace_uuid ON property(workspace_id, uuid);
CREATE INDEX IF NOT EXISTS idx_property_name ON property(name);
CREATE INDEX IF NOT EXISTS idx_property_workspace_id ON property(workspace_id);
CREATE INDEX IF NOT EXISTS idx_property_node_id ON property(node_id) WHERE node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_property_create_uid ON property(create_uid);
CREATE INDEX IF NOT EXISTS idx_property_write_uid ON property(write_uid);
-- Unique constraint for workspace properties (name unique per workspace, non-local)
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_workspace ON property(name, workspace_id) 
    WHERE is_local = FALSE AND active = TRUE;
-- Unique constraint for local properties (unique name per node_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_local ON property(name, node_id) 
    WHERE is_local = TRUE AND active = TRUE;

-- Property class filters
CREATE TABLE IF NOT EXISTS property_class_filter (
    id SERIAL PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    class_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    UNIQUE(property_id, class_node_id)
);

CREATE INDEX IF NOT EXISTS idx_property_class_filter_property_id ON property_class_filter(property_id);
CREATE INDEX IF NOT EXISTS idx_property_class_filter_class_node_id ON property_class_filter(class_node_id);

-- Node property assignment (links a node to a property)
CREATE TABLE IF NOT EXISTS node_property (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    UNIQUE(node_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_node_property_node_id ON node_property(node_id);
CREATE INDEX IF NOT EXISTS idx_node_property_property_id ON node_property(property_id);

-- ============================================================
-- PROPERTY VALUES
-- ============================================================

-- Property value scalar - for integer, float, boolean, text types
CREATE TABLE IF NOT EXISTS property_value_scalar (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    node_property_id INTEGER NOT NULL REFERENCES node_property(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    value_text TEXT,
    value_boolean BOOLEAN,
    value_float DOUBLE PRECISION,
    value_integer BIGINT,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pvs_node_property_id ON property_value_scalar(node_property_id);
CREATE INDEX IF NOT EXISTS idx_pvs_property_id ON property_value_scalar(property_id);
CREATE INDEX IF NOT EXISTS idx_pvs_node_id ON property_value_scalar(node_id);

-- Property value relation - for node, image, date relation types
CREATE TABLE IF NOT EXISTS property_value_relation (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    node_property_id INTEGER NOT NULL REFERENCES node_property(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    "order" INTEGER DEFAULT 0,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pvr_node_property_id ON property_value_relation(node_property_id);
CREATE INDEX IF NOT EXISTS idx_pvr_property_id ON property_value_relation(property_id);
CREATE INDEX IF NOT EXISTS idx_pvr_node_id ON property_value_relation(node_id);
CREATE INDEX IF NOT EXISTS idx_pvr_target_id ON property_value_relation(target_id);

-- Property selection line - options for selection-type properties
CREATE TABLE IF NOT EXISTS property_selection_line (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    icon VARCHAR(100),
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_selection_line_property_id ON property_selection_line(property_id);

-- Property value selection - for selection-type properties
CREATE TABLE IF NOT EXISTS property_value_selection (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    node_property_id INTEGER NOT NULL REFERENCES node_property(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    selection_line_id INTEGER NOT NULL REFERENCES property_selection_line(id) ON DELETE RESTRICT,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pvsel_node_property_id ON property_value_selection(node_property_id);
CREATE INDEX IF NOT EXISTS idx_pvsel_property_id ON property_value_selection(property_id);
CREATE INDEX IF NOT EXISTS idx_pvsel_node_id ON property_value_selection(node_id);
CREATE INDEX IF NOT EXISTS idx_pvsel_selection_line_id ON property_value_selection(selection_line_id);

-- ============================================================
-- CLASS SYSTEM
-- ============================================================

-- Class properties (properties associated with a class)
CREATE TABLE IF NOT EXISTS class_property (
    id SERIAL PRIMARY KEY,
    class_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    sequence INTEGER DEFAULT 0,
    hidden BOOLEAN DEFAULT FALSE,
    default_integer BIGINT,
    default_float DOUBLE PRECISION,
    default_text TEXT,
    default_boolean BOOLEAN,
    default_node_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    default_selection_id INTEGER REFERENCES property_selection_line(id) ON DELETE SET NULL,
    UNIQUE(class_node_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_class_property_class_node_id ON class_property(class_node_id);
CREATE INDEX IF NOT EXISTS idx_class_property_property_id ON class_property(property_id);

-- Class extends (inheritance)
CREATE TABLE IF NOT EXISTS class_extend (
    id SERIAL PRIMARY KEY,
    target_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    sequence INTEGER DEFAULT 0,
    UNIQUE(target_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_class_extend_target_id ON class_extend(target_id);
CREATE INDEX IF NOT EXISTS idx_class_extend_source_id ON class_extend(source_id);

-- ============================================================
-- LINKS & INLINE CLASSES
-- ============================================================

-- Node links (backlinks between nodes, including inline class references)
CREATE TABLE IF NOT EXISTS node_link (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    source_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    property_id INTEGER REFERENCES property(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    is_tag BOOLEAN DEFAULT FALSE,
    is_inline_class BOOLEAN DEFAULT FALSE,
    name TEXT,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_node_link_source_id ON node_link(source_id);
CREATE INDEX IF NOT EXISTS idx_node_link_target_id ON node_link(target_id);
CREATE INDEX IF NOT EXISTS idx_node_link_workspace_id ON node_link(workspace_id);
CREATE INDEX IF NOT EXISTS idx_node_link_property_id ON node_link(property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_node_link_source_target ON node_link(source_id, target_id);
-- idx_node_link_inline_class is created in the migration block below (safe for existing DBs)

-- Inline class references are now stored in node_link with is_inline_class = TRUE
-- (class_inline table has been merged into node_link)

-- ============================================================
-- NODE VIEWS (DYNAMIC QUERY TABS)
-- ============================================================
-- NodeViews store references to query nodes that define dynamic collections.
-- Each node can have multiple views per view_type, displayed as tabs.
-- The query_json stores the query block tree directly.

CREATE TABLE IF NOT EXISTS node_view (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    query_json JSONB NOT NULL DEFAULT '{"type": "AND_CONTAINER", "blocks": []}'::jsonb,
    view_type TEXT NOT NULL, -- e.g., child_pages, classed_nodes, linked_references, main_content
    order_index INTEGER DEFAULT 0,
    is_default BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    shown_properties JSONB DEFAULT '[]'::jsonb, -- Array of {uuid: string, sequence: number} for table view columns
    group_by TEXT DEFAULT NULL, -- Group by field for card view (e.g., 'page', 'type', property uuid)
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_node_view_node_id ON node_view(node_id);
CREATE INDEX IF NOT EXISTS idx_node_view_view_type ON node_view(view_type);
CREATE INDEX IF NOT EXISTS idx_node_view_node_view_type ON node_view(node_id, view_type);
CREATE INDEX IF NOT EXISTS idx_node_view_order ON node_view(node_id, view_type, order_index);

-- Ensure only one default view per node+view_type combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_view_default_unique 
    ON node_view(node_id, view_type) 
    WHERE is_default = TRUE;

-- ============================================================
-- SETTINGS & ACTIVITY
-- ============================================================

-- Workspace settings (key-value store per workspace)
CREATE TABLE IF NOT EXISTS setting_workspace (
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    value JSONB,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    PRIMARY KEY (workspace_id, key)
);

CREATE INDEX IF NOT EXISTS idx_setting_workspace_workspace_id ON setting_workspace(workspace_id);

-- User settings (key-value store per user)
CREATE TABLE IF NOT EXISTS setting_user (
    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    value JSONB,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_setting_user_user_id ON setting_user(user_id);

-- Node activity log
CREATE TABLE IF NOT EXISTS node_activity (
    id SERIAL PRIMARY KEY,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    action VARCHAR(100) NOT NULL,
    details TEXT,
    target_node_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_node_activity_node_id ON node_activity(node_id);
CREATE INDEX IF NOT EXISTS idx_node_activity_user_id ON node_activity(user_id);
CREATE INDEX IF NOT EXISTS idx_node_activity_create_date ON node_activity(create_date);

-- Link click tracking (per link instance via node_link.uuid)
CREATE TABLE IF NOT EXISTS link_click (
    id SERIAL PRIMARY KEY,
    source_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    node_link_uuid UUID,
    click_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

-- Migration: Add node_link_uuid column if table exists without it
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'link_click' AND column_name = 'node_link_uuid'
    ) THEN
        ALTER TABLE link_click ADD COLUMN node_link_uuid UUID;
    END IF;
END $$;

-- Migration: Add name column to node_link if table exists without it
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'node_link' AND column_name = 'name'
    ) THEN
        ALTER TABLE node_link ADD COLUMN name TEXT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_link_click_source_node_id ON link_click(source_node_id);
CREATE INDEX IF NOT EXISTS idx_link_click_target_node_id ON link_click(target_node_id);
CREATE INDEX IF NOT EXISTS idx_link_click_user_id ON link_click(user_id);
CREATE INDEX IF NOT EXISTS idx_link_click_node_link_uuid ON link_click(node_link_uuid) WHERE node_link_uuid IS NOT NULL;

-- ============================================================
-- MIGRATIONS: TYPE -> CLASS RENAMING
-- ============================================================

-- Migration: Rename is_type to is_class in node table
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'node' AND column_name = 'is_type')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'node' AND column_name = 'is_class') THEN
        ALTER TABLE node RENAME COLUMN is_type TO is_class;
    END IF;
END $$;

-- Migration: Rename type_property table to class_property
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'type_property')
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'class_property') THEN
        ALTER TABLE type_property RENAME TO class_property;
        ALTER TABLE class_property RENAME COLUMN type_node_id TO class_node_id;
    END IF;
END $$;

-- Migration: Rename type_extend table to class_extend
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'type_extend')
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'class_extend') THEN
        ALTER TABLE type_extend RENAME TO class_extend;
    END IF;
END $$;

-- Migration: Rename type_inline table to class_inline
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'type_inline')
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'class_inline') THEN
        ALTER TABLE type_inline RENAME TO class_inline;
        ALTER TABLE class_inline RENAME COLUMN type_id TO class_id;
    END IF;
END $$;

-- Migration: Add is_inline_class column to node_link and merge class_inline data
DO $$
BEGIN
    -- Add the is_inline_class column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node_link' AND column_name = 'is_inline_class'
    ) THEN
        ALTER TABLE node_link ADD COLUMN is_inline_class BOOLEAN DEFAULT FALSE;
    END IF;
    
    -- Migrate data from class_inline into node_link (if class_inline still exists)
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'class_inline') THEN
        INSERT INTO node_link (source_id, target_id, workspace_id, position, is_inline_class, create_date, create_uid)
        SELECT node_id, class_id, workspace_id, position, TRUE, create_date, create_uid
        FROM class_inline;
        
        -- Drop the old table
        DROP TABLE class_inline;
    END IF;
    
    -- Create partial index for inline class lookups
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'idx_node_link_inline_class'
    ) THEN
        CREATE INDEX idx_node_link_inline_class ON node_link(target_id) WHERE is_inline_class = TRUE;
    END IF;
END $$;

-- Migration: Rename property_type_filter table to property_class_filter
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'property_type_filter')
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'property_class_filter') THEN
        ALTER TABLE property_type_filter RENAME TO property_class_filter;
        ALTER TABLE property_class_filter RENAME COLUMN type_node_id TO class_node_id;
    END IF;
END $$;

-- Migration: Add icon_visibility column to property table
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'property' AND column_name = 'icon_visibility'
    ) THEN
        ALTER TABLE property ADD COLUMN icon_visibility VARCHAR(50) DEFAULT 'hidden';
    END IF;
END $$;

-- ============================================================
-- SCHEMA METADATA
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_meta (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- NODE PATH (CLOSURE TABLE FOR HIERARCHY)
-- ============================================================
-- This table stores the transitive closure of the node hierarchy.
-- For each node, it contains rows for all ancestors (including self).
-- This enables efficient breadcrumb queries without recursion.

CREATE TABLE IF NOT EXISTS node_path (
    ancestor_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    descendant_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    depth INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ancestor_id, descendant_id)
);

-- Index for fast descendant queries (find all descendants of a node)
CREATE INDEX IF NOT EXISTS idx_node_path_ancestor ON node_path(ancestor_id, depth);

-- Index for fast ancestor/breadcrumb queries (find all ancestors of a node)
CREATE INDEX IF NOT EXISTS idx_node_path_descendant ON node_path(descendant_id, depth);

-- ============================================================
-- NODE PATH MAINTENANCE FUNCTIONS
-- ============================================================

-- Function: Insert paths for a new node
-- When a node is inserted, we add:
--   1. A self-reference row (ancestor=self, descendant=self, depth=0)
--   2. Rows linking all ancestors of parent to this new node (depth = parent's depth + 1)
CREATE OR REPLACE FUNCTION node_path_insert()
RETURNS TRIGGER AS $$
BEGIN
    -- Always insert self-reference (every node is its own ancestor at depth 0)
    INSERT INTO node_path (ancestor_id, descendant_id, depth)
    VALUES (NEW.id, NEW.id, 0);
    
    -- If node has a parent, copy all ancestor paths from parent
    -- and increment depth by 1
    IF NEW.parent_id IS NOT NULL THEN
        INSERT INTO node_path (ancestor_id, descendant_id, depth)
        SELECT np.ancestor_id, NEW.id, np.depth + 1
        FROM node_path np
        WHERE np.descendant_id = NEW.parent_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function: Update paths when a node's parent changes
-- This is the most complex operation:
--   1. Remove all paths from OLD ancestors to this node and its subtree
--   2. Add new paths from NEW ancestors to this node and its subtree
CREATE OR REPLACE FUNCTION node_path_update()
RETURNS TRIGGER AS $$
BEGIN
    -- Only proceed if parent_id actually changed
    IF OLD.parent_id IS DISTINCT FROM NEW.parent_id THEN
        -- Step 1: Delete all paths where:
        --   - The descendant is this node or any of its descendants
        --   - The ancestor is NOT this node or any of its descendants
        -- (We keep the internal subtree paths intact)
        DELETE FROM node_path
        WHERE descendant_id IN (
            -- All descendants of the moved node (including itself)
            SELECT descendant_id FROM node_path WHERE ancestor_id = NEW.id
        )
        AND ancestor_id NOT IN (
            -- Ancestors that are part of the subtree (keep these)
            SELECT descendant_id FROM node_path WHERE ancestor_id = NEW.id
        );
        
        -- Step 2: Insert new paths from new ancestors to moved subtree
        IF NEW.parent_id IS NOT NULL THEN
            INSERT INTO node_path (ancestor_id, descendant_id, depth)
            SELECT 
                ancestors.ancestor_id,
                subtree.descendant_id,
                ancestors.depth + subtree.depth + 1
            FROM 
                -- All ancestors of the new parent (including new parent itself)
                node_path ancestors
            CROSS JOIN 
                -- All descendants of moved node (including itself)
                node_path subtree
            WHERE 
                ancestors.descendant_id = NEW.parent_id
                AND subtree.ancestor_id = NEW.id;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function: Delete paths when a node is deleted
-- PostgreSQL CASCADE will handle most cleanup, but we explicitly
-- remove paths for clarity and to handle subtree deletion properly
CREATE OR REPLACE FUNCTION node_path_delete()
RETURNS TRIGGER AS $$
BEGIN
    -- Delete all paths where this node is ancestor or descendant
    -- (CASCADE on FK will do this, but being explicit)
    DELETE FROM node_path 
    WHERE ancestor_id = OLD.id OR descendant_id = OLD.id;
    
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- REBUILD_NODE_PATH FUNCTION
-- ============================================================
-- Rebuilds the entire node_path closure table from scratch.
-- Use this to repair missing entries or after bulk data imports.
-- This is idempotent - can be run multiple times safely.
--
-- Usage: SELECT rebuild_node_path();

CREATE OR REPLACE FUNCTION rebuild_node_path()
RETURNS void AS $$
BEGIN
    -- Clear existing data
    TRUNCATE node_path;
    
    -- Insert self-references for all active nodes (depth 0)
    INSERT INTO node_path (ancestor_id, descendant_id, depth)
    SELECT id, id, 0 FROM node WHERE active = TRUE;
    
    -- Build full closure using recursive CTE
    -- This finds all ancestor-descendant pairs and their depths
    WITH RECURSIVE node_closure AS (
        -- Base case: direct parent-child relationships (depth 1)
        SELECT parent_id as ancestor_id, id as descendant_id, 1 as depth
        FROM node
        WHERE parent_id IS NOT NULL AND active = TRUE
        
        UNION ALL
        
        -- Recursive case: extend paths through the hierarchy
        SELECT nc.ancestor_id, n.id, nc.depth + 1
        FROM node_closure nc
        JOIN node n ON n.parent_id = nc.descendant_id
        WHERE n.active = TRUE
    )
    INSERT INTO node_path (ancestor_id, descendant_id, depth)
    SELECT ancestor_id, descendant_id, depth FROM node_closure;
    
    RAISE NOTICE 'node_path table rebuilt with % entries', (SELECT COUNT(*) FROM node_path);
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- GET_BREADCRUMBS FUNCTION
-- ============================================================
-- Returns ordered list of nodes from root (or enter_node) down to exit_node.
-- Uses node_path closure table for efficient ancestor lookup.
--
-- Parameters:
--   exit_node_id: The node to get breadcrumbs for (required)
--   enter_node_id: Optional starting ancestor (if NULL, starts from root)
--
-- Returns: Table of nodes ordered from root/enter_node to exit_node
--
-- Example usage:
--   SELECT * FROM get_breadcrumbs(123);           -- Full path from root
--   SELECT * FROM get_breadcrumbs(123, 45);       -- Path from node 45 to node 123

CREATE OR REPLACE FUNCTION get_breadcrumbs(
    exit_node_id INTEGER,
    enter_node_id INTEGER DEFAULT NULL
)
RETURNS TABLE (
    id INTEGER,
    uuid UUID,
    name TEXT,
    is_page BOOLEAN,
    is_class BOOLEAN,
    is_day BOOLEAN,
    is_month BOOLEAN,
    is_year BOOLEAN,
    parent_id INTEGER,
    depth INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        n.id,
        n.uuid,
        n.name,
        n.is_page,
        n.is_class,
        n.is_day,
        n.is_month,
        n.is_year,
        n.parent_id,
        np.depth
    FROM node_path np
    JOIN node n ON n.id = np.ancestor_id
    WHERE np.descendant_id = exit_node_id
      AND n.active = TRUE
      -- If enter_node_id is specified, only include ancestors at or below that depth
      AND (
          enter_node_id IS NULL 
          OR np.depth <= (
              SELECT np2.depth 
              FROM node_path np2 
              WHERE np2.ancestor_id = enter_node_id 
                AND np2.descendant_id = exit_node_id
          )
      )
    ORDER BY np.depth DESC;  -- Root first (highest depth), exit_node last (depth 0)
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Full-text search trigger
CREATE OR REPLACE FUNCTION update_node_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector := to_tsvector(
        COALESCE(NEW.search_language, 'english')::regconfig,
        COALESCE(NEW.name, '')
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS node_search_update ON node;
CREATE TRIGGER node_search_update
    BEFORE INSERT OR UPDATE OF name, search_language ON node
    FOR EACH ROW
    EXECUTE FUNCTION update_node_search_vector();

-- ============================================================
-- NODE PATH TRIGGERS (Closure Table Maintenance)
-- ============================================================
-- These triggers automatically maintain the node_path closure table
-- whenever nodes are inserted, updated (parent change), or deleted.

-- Trigger: Maintain node_path on INSERT
-- Fires AFTER insert so we have the new node's ID
DROP TRIGGER IF EXISTS node_path_after_insert ON node;
CREATE TRIGGER node_path_after_insert
    AFTER INSERT ON node
    FOR EACH ROW
    EXECUTE FUNCTION node_path_insert();

-- Trigger: Maintain node_path on UPDATE (parent_id change)
-- Only fires when parent_id changes to avoid unnecessary work
DROP TRIGGER IF EXISTS node_path_after_update ON node;
CREATE TRIGGER node_path_after_update
    AFTER UPDATE OF parent_id ON node
    FOR EACH ROW
    WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id)
    EXECUTE FUNCTION node_path_update();

-- Trigger: Maintain node_path on DELETE
-- Fires BEFORE delete so we can still access the node's relationships
DROP TRIGGER IF EXISTS node_path_before_delete ON node;
CREATE TRIGGER node_path_before_delete
    BEFORE DELETE ON node
    FOR EACH ROW
    EXECUTE FUNCTION node_path_delete();

-- Auto-update write_date trigger
CREATE OR REPLACE FUNCTION update_write_date()
RETURNS TRIGGER AS $$
BEGIN
    NEW.write_date := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply write_date trigger to major tables
DROP TRIGGER IF EXISTS user_write_date ON "user";
CREATE TRIGGER user_write_date
    BEFORE UPDATE ON "user"
    FOR EACH ROW
    EXECUTE FUNCTION update_write_date();

DROP TRIGGER IF EXISTS workspace_write_date ON workspace;
CREATE TRIGGER workspace_write_date
    BEFORE UPDATE ON workspace
    FOR EACH ROW
    EXECUTE FUNCTION update_write_date();

DROP TRIGGER IF EXISTS node_write_date ON node;
CREATE TRIGGER node_write_date
    BEFORE UPDATE ON node
    FOR EACH ROW
    EXECUTE FUNCTION update_write_date();

DROP TRIGGER IF EXISTS property_write_date ON property;
CREATE TRIGGER property_write_date
    BEFORE UPDATE ON property
    FOR EACH ROW
    EXECUTE FUNCTION update_write_date();

-- Function to update workspace's write_date when nodes are modified
CREATE OR REPLACE FUNCTION update_workspace_write_date()
RETURNS TRIGGER AS $$
BEGIN
    -- For INSERT and UPDATE, use NEW.workspace_id
    -- For DELETE, use OLD.workspace_id
    IF (TG_OP = 'DELETE') THEN
        UPDATE workspace SET write_date = NOW() WHERE id = OLD.workspace_id;
        RETURN OLD;
    ELSE
        UPDATE workspace SET write_date = NOW() WHERE id = NEW.workspace_id;
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update workspace write_date on node changes
DROP TRIGGER IF EXISTS node_update_workspace_write_date ON node;
CREATE TRIGGER node_update_workspace_write_date
    AFTER INSERT OR UPDATE OR DELETE ON node
    FOR EACH ROW
    EXECUTE FUNCTION update_workspace_write_date();

-- ============================================================
-- EXAMPLE USAGE: BREADCRUMBS
-- ============================================================
-- 
-- Example 1: Get full breadcrumb path from root to a document node
--   SELECT * FROM get_breadcrumbs(123);
--   
--   This returns all ancestors from the root down to node 123:
--   | id  | uuid | name        | is_page | depth |
--   |-----|------|-------------|---------|-------|
--   | 1   | ...  | Root Page   | true    | 3     |
--   | 45  | ...  | Chapter 1   | true    | 2     |
--   | 89  | ...  | Section A   | false   | 1     |
--   | 123 | ...  | My Document | false   | 0     |
--
-- Example 2: Get breadcrumb path starting from a specific ancestor
--   SELECT * FROM get_breadcrumbs(123, 45);
--   
--   This returns the path from node 45 down to node 123:
--   | id  | uuid | name        | is_page | depth |
--   |-----|------|-------------|---------|-------|
--   | 45  | ...  | Chapter 1   | true    | 2     |
--   | 89  | ...  | Section A   | false   | 1     |
--   | 123 | ...  | My Document | false   | 0     |
--
-- Example 3: Get only page ancestors (filter in app layer)
--   SELECT * FROM get_breadcrumbs(123) WHERE is_page = TRUE;
--
-- Example 4: Get all descendants of a node (useful for subtree operations)
--   SELECT n.* FROM node_path np
--   JOIN node n ON n.id = np.descendant_id
--   WHERE np.ancestor_id = 45 AND np.depth > 0;
--
-- Example 5: Check if node A is an ancestor of node B
--   SELECT EXISTS(
--     SELECT 1 FROM node_path 
--     WHERE ancestor_id = A AND descendant_id = B
--   );
"""
