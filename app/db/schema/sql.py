"""PostgreSQL DDL schema for Notees.

This module contains the raw SQL schema definition for creating
all database tables, indexes, and triggers.

SCHEMA VERSION: 2 - Graph-based architecture with granular permissions.

Key changes from v1:
- "workspace" -> "graph" terminology
- Added graph_share and node_share tables for granular permissions
- Added uuid and audit fields (create_uid, write_uid) to most tables
- Renamed: source_node_id -> source_id, target_node_id -> target_id
- Renamed: inline_type -> type_inline, type_extends -> type_extend
- Renamed: settings -> setting_graph + setting_user
- Removed: order fields from property values (ordering handled differently)
- Added: is_active -> active standardization
"""

SCHEMA_SQL = """
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- CORE IDENTITY & ACCESS
-- ============================================================

-- User table (global, not per graph)
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
-- GRAPHS
-- ============================================================

-- Graph table (replaces workspace)
CREATE TABLE IF NOT EXISTS graph (
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

CREATE INDEX IF NOT EXISTS idx_graph_create_uid ON graph(create_uid);
CREATE INDEX IF NOT EXISTS idx_graph_write_uid ON graph(write_uid);
-- Unique graph name per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_name_per_user ON graph(name, create_uid) WHERE active = TRUE;

-- Graph sharing with granular permissions
CREATE TABLE IF NOT EXISTS graph_share (
    id SERIAL PRIMARY KEY,
    graph_id INTEGER NOT NULL REFERENCES graph(id) ON DELETE CASCADE,
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
    UNIQUE(graph_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_graph_share_graph_id ON graph_share(graph_id);
CREATE INDEX IF NOT EXISTS idx_graph_share_user_id ON graph_share(user_id);

-- ============================================================
-- NODES
-- ============================================================

-- Node table - the core entity
CREATE TABLE IF NOT EXISTS node (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    graph_id INTEGER NOT NULL REFERENCES graph(id) ON DELETE CASCADE,
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
    -- Type flags (denormalized for fast queries)
    is_type BOOLEAN DEFAULT FALSE,
    is_page BOOLEAN DEFAULT FALSE,
    is_day BOOLEAN DEFAULT FALSE,
    is_month BOOLEAN DEFAULT FALSE,
    is_year BOOLEAN DEFAULT FALSE,
    is_asset BOOLEAN DEFAULT FALSE,
    is_template BOOLEAN DEFAULT FALSE,
    is_comment BOOLEAN DEFAULT FALSE,
    -- Type-specific fields
    usable_in VARCHAR(10) DEFAULT 'both' CHECK (usable_in IN ('page', 'block', 'both')),
    types_path JSONB DEFAULT '[]'::jsonb,
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
CREATE INDEX IF NOT EXISTS idx_node_graph_id ON node(graph_id);
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
CREATE INDEX IF NOT EXISTS idx_node_create_uid ON node(create_uid);
CREATE INDEX IF NOT EXISTS idx_node_write_uid ON node(write_uid);
-- Unique page name per graph + parent
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_page_unique ON node(graph_id, parent_id, name) 
    WHERE is_page = TRUE AND active = TRUE;

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
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    graph_id INTEGER REFERENCES graph(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    icon VARCHAR(100),
    type VARCHAR(50) NOT NULL DEFAULT 'text',
    is_multi BOOLEAN DEFAULT FALSE,
    is_system BOOLEAN DEFAULT FALSE,
    is_local BOOLEAN DEFAULT FALSE,
    node_id INTEGER REFERENCES node(id) ON DELETE CASCADE,
    active BOOLEAN DEFAULT TRUE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    CHECK (is_local = FALSE OR node_id IS NOT NULL),
    CHECK (type NOT IN ('text', 'image') OR is_multi = FALSE)
);

CREATE INDEX IF NOT EXISTS idx_property_uuid ON property(uuid);
CREATE INDEX IF NOT EXISTS idx_property_name ON property(name);
CREATE INDEX IF NOT EXISTS idx_property_graph_id ON property(graph_id);
CREATE INDEX IF NOT EXISTS idx_property_node_id ON property(node_id) WHERE node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_property_create_uid ON property(create_uid);
CREATE INDEX IF NOT EXISTS idx_property_write_uid ON property(write_uid);
-- Unique constraint for global properties (graph NULL, non-local)
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_global ON property(name) 
    WHERE is_local = FALSE AND graph_id IS NULL AND active = TRUE;
-- Unique constraint for graph properties
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_graph ON property(name, graph_id) 
    WHERE is_local = FALSE AND graph_id IS NOT NULL AND active = TRUE;
-- Unique constraint for local properties (unique name per node_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_local ON property(name, node_id) 
    WHERE is_local = TRUE AND active = TRUE;

-- Property type filters
CREATE TABLE IF NOT EXISTS property_type_filter (
    id SERIAL PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    UNIQUE(property_id, type_node_id)
);

CREATE INDEX IF NOT EXISTS idx_property_type_filter_property_id ON property_type_filter(property_id);
CREATE INDEX IF NOT EXISTS idx_property_type_filter_type_node_id ON property_type_filter(type_node_id);

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
-- TYPE SYSTEM
-- ============================================================

-- Type properties (properties associated with a type)
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
    default_node_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    default_selection_id INTEGER REFERENCES property_selection_line(id) ON DELETE SET NULL,
    UNIQUE(type_node_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_type_property_type_node_id ON type_property(type_node_id);
CREATE INDEX IF NOT EXISTS idx_type_property_property_id ON type_property(property_id);

-- Type extends (inheritance)
CREATE TABLE IF NOT EXISTS type_extend (
    id SERIAL PRIMARY KEY,
    target_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    sequence INTEGER DEFAULT 0,
    UNIQUE(target_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_type_extend_target_id ON type_extend(target_id);
CREATE INDEX IF NOT EXISTS idx_type_extend_source_id ON type_extend(source_id);

-- ============================================================
-- LINKS & INLINE TYPES
-- ============================================================

-- Node links (backlinks between nodes)
CREATE TABLE IF NOT EXISTS node_link (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    source_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    graph_id INTEGER NOT NULL REFERENCES graph(id) ON DELETE CASCADE,
    property_id INTEGER REFERENCES property(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    is_tag BOOLEAN DEFAULT FALSE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_node_link_source_id ON node_link(source_id);
CREATE INDEX IF NOT EXISTS idx_node_link_target_id ON node_link(target_id);
CREATE INDEX IF NOT EXISTS idx_node_link_graph_id ON node_link(graph_id);
CREATE INDEX IF NOT EXISTS idx_node_link_property_id ON node_link(property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_node_link_source_target ON node_link(source_id, target_id);

-- Inline type references ({{typeId}} in content)
CREATE TABLE IF NOT EXISTS type_inline (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    type_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    graph_id INTEGER NOT NULL REFERENCES graph(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_type_inline_node_id ON type_inline(node_id);
CREATE INDEX IF NOT EXISTS idx_type_inline_type_id ON type_inline(type_id);
CREATE INDEX IF NOT EXISTS idx_type_inline_graph_id ON type_inline(graph_id);

-- ============================================================
-- SETTINGS & ACTIVITY
-- ============================================================

-- Graph settings (key-value store per graph)
CREATE TABLE IF NOT EXISTS setting_graph (
    graph_id INTEGER NOT NULL REFERENCES graph(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    value JSONB,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    PRIMARY KEY (graph_id, key)
);

CREATE INDEX IF NOT EXISTS idx_setting_graph_graph_id ON setting_graph(graph_id);

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

-- Link click tracking (source-target based)
CREATE TABLE IF NOT EXISTS link_click (
    id SERIAL PRIMARY KEY,
    source_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    click_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_link_click_source_node_id ON link_click(source_node_id);
CREATE INDEX IF NOT EXISTS idx_link_click_target_node_id ON link_click(target_node_id);
CREATE INDEX IF NOT EXISTS idx_link_click_user_id ON link_click(user_id);

-- ============================================================
-- SCHEMA METADATA
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_meta (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

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

DROP TRIGGER IF EXISTS graph_write_date ON graph;
CREATE TRIGGER graph_write_date
    BEFORE UPDATE ON graph
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
"""
