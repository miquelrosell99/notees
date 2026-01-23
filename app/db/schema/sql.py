"""PostgreSQL DDL schema for Notees.

This module contains the raw SQL schema definition for creating
all database tables, indexes, and triggers.
"""

SCHEMA_SQL = """
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- User table (global, not per workspace)
CREATE TABLE IF NOT EXISTS "user" (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    username VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Workspace for multi-tenant support
CREATE TABLE IF NOT EXISTS workspace (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    is_shared BOOLEAN DEFAULT FALSE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_owner ON workspace(owner_id);

-- Workspace membership
CREATE TABLE IF NOT EXISTS workspace_member (
    id SERIAL PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'viewer',  -- owner, editor, viewer
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_member_workspace ON workspace_member(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_member_user ON workspace_member(user_id);

-- Node table - the core entity
CREATE TABLE IF NOT EXISTS node (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    icon VARCHAR(100),
    color VARCHAR(50),
    parent_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    page_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    sequence INTEGER DEFAULT 0,
    collapsed BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    version INTEGER DEFAULT 1,  -- Optimistic locking
    -- Type flags (denormalized for fast queries)
    is_type BOOLEAN DEFAULT FALSE,
    is_page BOOLEAN DEFAULT FALSE,
    is_day BOOLEAN DEFAULT FALSE,
    is_month BOOLEAN DEFAULT FALSE,
    is_year BOOLEAN DEFAULT FALSE,
    is_asset BOOLEAN DEFAULT FALSE,
    is_template BOOLEAN DEFAULT FALSE,
    is_comment BOOLEAN DEFAULT FALSE,
    usable_in VARCHAR(20) DEFAULT 'both',
    cover_image_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    types_path JSONB DEFAULT '[]'::jsonb,
    open_date TIMESTAMPTZ,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id),
    write_uid INTEGER REFERENCES "user"(id),
    -- Full-text search
    search_vector tsvector,
    search_language VARCHAR(50) DEFAULT 'english'
);

-- Node indexes
CREATE INDEX IF NOT EXISTS idx_node_workspace ON node(workspace_id);
CREATE INDEX IF NOT EXISTS idx_node_uuid ON node(uuid);
CREATE INDEX IF NOT EXISTS idx_node_parent_id ON node(parent_id);
CREATE INDEX IF NOT EXISTS idx_node_page_id ON node(page_id);
CREATE INDEX IF NOT EXISTS idx_node_name ON node(name);
CREATE INDEX IF NOT EXISTS idx_node_is_page ON node(is_page) WHERE is_page = TRUE;
CREATE INDEX IF NOT EXISTS idx_node_is_type ON node(is_type) WHERE is_type = TRUE;
CREATE INDEX IF NOT EXISTS idx_node_is_day ON node(is_day) WHERE is_day = TRUE;
CREATE INDEX IF NOT EXISTS idx_node_open_date ON node(open_date) WHERE open_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_node_types_path ON node USING GIN (types_path);
CREATE INDEX IF NOT EXISTS idx_node_search ON node USING GIN (search_vector);

-- Property definition
CREATE TABLE IF NOT EXISTS property (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    workspace_id INTEGER REFERENCES workspace(id) ON DELETE CASCADE,  -- NULL for global
    name VARCHAR(255) NOT NULL,
    icon VARCHAR(100),
    type VARCHAR(50) NOT NULL DEFAULT 'text',
    is_multi BOOLEAN DEFAULT FALSE,
    is_system BOOLEAN DEFAULT FALSE,
    is_local BOOLEAN DEFAULT FALSE,
    node_id INTEGER REFERENCES node(id) ON DELETE CASCADE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (is_local = TRUE OR node_id IS NULL),
    CHECK (type NOT IN ('text', 'image') OR is_multi = FALSE)
);

CREATE INDEX IF NOT EXISTS idx_property_uuid ON property(uuid);
CREATE INDEX IF NOT EXISTS idx_property_name ON property(name);
CREATE INDEX IF NOT EXISTS idx_property_workspace ON property(workspace_id);
CREATE INDEX IF NOT EXISTS idx_property_node_id ON property(node_id) WHERE node_id IS NOT NULL;
-- Unique constraint for global properties (workspace NULL, non-local)
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_global ON property(name) 
    WHERE is_local = FALSE AND workspace_id IS NULL;
-- Unique constraint for workspace properties
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_workspace ON property(name, workspace_id) 
    WHERE is_local = FALSE AND workspace_id IS NOT NULL;
-- Unique constraint for local properties (unique name per node_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_local ON property(name, node_id) 
    WHERE is_local = TRUE;

-- Node property assignment table
CREATE TABLE IF NOT EXISTS node_property (
    id SERIAL PRIMARY KEY,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(node_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_node_property_node ON node_property(node_id);
CREATE INDEX IF NOT EXISTS idx_node_property_property ON node_property(property_id);

-- Property value scalar - for integer, float, boolean types
CREATE TABLE IF NOT EXISTS property_value_scalar (
    id SERIAL PRIMARY KEY,
    node_property_id INTEGER NOT NULL REFERENCES node_property(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    value_text TEXT,
    value_boolean BOOLEAN,
    value_float DOUBLE PRECISION,
    value_integer BIGINT,
    "order" INTEGER DEFAULT 0,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pvs_node_property ON property_value_scalar(node_property_id);
CREATE INDEX IF NOT EXISTS idx_pvs_property ON property_value_scalar(property_id);
CREATE INDEX IF NOT EXISTS idx_pvs_node ON property_value_scalar(node_id);

-- Property value relation - for node, text, image, date types
CREATE TABLE IF NOT EXISTS property_value_relation (
    id SERIAL PRIMARY KEY,
    node_property_id INTEGER NOT NULL REFERENCES node_property(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    "order" INTEGER DEFAULT 0,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pvr_node_property ON property_value_relation(node_property_id);
CREATE INDEX IF NOT EXISTS idx_pvr_property ON property_value_relation(property_id);
CREATE INDEX IF NOT EXISTS idx_pvr_node ON property_value_relation(node_id);
CREATE INDEX IF NOT EXISTS idx_pvr_target ON property_value_relation(target_node_id);

-- Property selection line - options for selection-type properties
CREATE TABLE IF NOT EXISTS property_selection_line (
    id SERIAL PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    icon VARCHAR(100),
    "order" INTEGER DEFAULT 0,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_selection_line_property ON property_selection_line(property_id);

-- Property value selection - for selection-type properties
CREATE TABLE IF NOT EXISTS property_value_selection (
    id SERIAL PRIMARY KEY,
    node_property_id INTEGER NOT NULL REFERENCES node_property(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    selection_line_id INTEGER NOT NULL REFERENCES property_selection_line(id) ON DELETE RESTRICT,
    "order" INTEGER DEFAULT 0,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pvsel_node_property ON property_value_selection(node_property_id);
CREATE INDEX IF NOT EXISTS idx_pvsel_property ON property_value_selection(property_id);
CREATE INDEX IF NOT EXISTS idx_pvsel_node ON property_value_selection(node_id);
CREATE INDEX IF NOT EXISTS idx_pvsel_selection_line ON property_value_selection(selection_line_id);

-- Property type filters
CREATE TABLE IF NOT EXISTS property_type_filter (
    id SERIAL PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    UNIQUE(property_id, type_node_id)
);

CREATE INDEX IF NOT EXISTS idx_type_filter_property ON property_type_filter(property_id);

-- Type properties
CREATE TABLE IF NOT EXISTS type_property (
    id SERIAL PRIMARY KEY,
    type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    sequence INTEGER DEFAULT 0,
    hidden BOOLEAN DEFAULT FALSE,
    default_integer BIGINT,
    default_float DOUBLE PRECISION,
    default_text TEXT,
    default_boolean BOOLEAN,
    default_node_id INTEGER REFERENCES node(id),
    default_selection_id INTEGER REFERENCES property_selection_line(id),
    UNIQUE(type_node_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_type_property_type ON type_property(type_node_id);
CREATE INDEX IF NOT EXISTS idx_type_property_property ON type_property(property_id);

-- Type extends (inheritance)
CREATE TABLE IF NOT EXISTS type_extends (
    id SERIAL PRIMARY KEY,
    type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    extends_type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    sequence INTEGER DEFAULT 0,
    UNIQUE(type_node_id, extends_type_node_id)
);

CREATE INDEX IF NOT EXISTS idx_type_extends_type ON type_extends(type_node_id);
CREATE INDEX IF NOT EXISTS idx_type_extends_parent ON type_extends(extends_type_node_id);

-- Node links (backlinks)
CREATE TABLE IF NOT EXISTS node_link (
    id SERIAL PRIMARY KEY,
    source_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    property_id INTEGER REFERENCES property(id) ON DELETE CASCADE,
    is_tag BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_link_source ON node_link(source_node_id);
CREATE INDEX IF NOT EXISTS idx_link_target ON node_link(target_node_id);
CREATE INDEX IF NOT EXISTS idx_link_property ON node_link(property_id) WHERE property_id IS NOT NULL;
-- Composite indexes for common join patterns
CREATE INDEX IF NOT EXISTS idx_link_source_target ON node_link(source_node_id, target_node_id);
CREATE INDEX IF NOT EXISTS idx_link_target_property ON node_link(target_node_id, property_id);

-- Inline type references
CREATE TABLE IF NOT EXISTS inline_type (
    id SERIAL PRIMARY KEY,
    source_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inline_type_source ON inline_type(source_node_id);
CREATE INDEX IF NOT EXISTS idx_inline_type_target ON inline_type(type_node_id);

-- Node comments
CREATE TABLE IF NOT EXISTS node_comment (
    id SERIAL PRIMARY KEY,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    comment_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    sequence INTEGER DEFAULT 0,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(node_id, comment_node_id)
);

CREATE INDEX IF NOT EXISTS idx_comment_node ON node_comment(node_id);
CREATE INDEX IF NOT EXISTS idx_comment_comment_node ON node_comment(comment_node_id);

-- Workspace settings (key-value store)
CREATE TABLE IF NOT EXISTS settings (
    workspace_id INTEGER REFERENCES workspace(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    value JSONB,
    PRIMARY KEY (workspace_id, key)
);

-- Node activity log
CREATE TABLE IF NOT EXISTS node_activity (
    id SERIAL PRIMARY KEY,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    action VARCHAR(100) NOT NULL,
    details TEXT,
    target_node_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_node ON node_activity(node_id);
CREATE INDEX IF NOT EXISTS idx_activity_date ON node_activity(create_date);
CREATE INDEX IF NOT EXISTS idx_activity_user ON node_activity(user_id);

-- Link click tracking
CREATE TABLE IF NOT EXISTS link_click (
    id SERIAL PRIMARY KEY,
    source_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    click_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_click_source ON link_click(source_node_id);
CREATE INDEX IF NOT EXISTS idx_click_target ON link_click(target_node_id);
CREATE INDEX IF NOT EXISTS idx_click_date ON link_click(click_date);
CREATE INDEX IF NOT EXISTS idx_click_source_target ON link_click(source_node_id, target_node_id);

-- Schema metadata
CREATE TABLE IF NOT EXISTS schema_meta (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

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
"""
