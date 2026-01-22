"""PostgreSQL database schema for Notees.

This module defines the PostgreSQL schema, initialization, and seeding functions.
All tables support multi-user workspaces and include optimistic locking.
"""
from __future__ import annotations

import asyncpg
from datetime import datetime, timezone, date
from typing import Optional

from ..domain.entities import generate_uuid


# Schema version for migrations
SCHEMA_VERSION = 1


def utc_now_iso() -> str:
    """Get current UTC time as ISO string."""
    return datetime.now(timezone.utc).isoformat()


def generate_day_uuid(d: date) -> str:
    """Generate UUID for a day node.
    
    Format: 00000000-0000-0000-00DD-YYYYMMDD0000
    This creates a valid UUID with the date embedded in the last segment.
    """
    return f"00000000-0000-0000-00dd-{d.year:04d}{d.month:02d}{d.day:02d}0000"


def generate_month_uuid(year: int, month: int) -> str:
    """Generate UUID for a month node.
    
    Format: 00000000-0000-0000-00mm-YYYYMM000000
    """
    return f"00000000-0000-0000-00aa-{year:04d}{month:02d}000000"


def generate_year_uuid(year: int) -> str:
    """Generate UUID for a year node.
    
    Format: 00000000-0000-0000-00yy-YYYY00000000
    """
    return f"00000000-0000-0000-00bb-{year:04d}00000000"


def parse_date_uuid(uuid: str) -> Optional[dict]:
    """Parse a date UUID to extract year, month, day.
    
    Returns dict with 'type' ('year', 'month', 'day') and date components.
    Returns None if not a date UUID.
    """
    if not uuid or len(uuid) != 36:
        return None
    
    # Check for day UUID pattern: 00000000-0000-0000-00dd-YYYYMMDD0000
    if uuid.startswith("00000000-0000-0000-00dd-"):
        try:
            data = uuid[-12:]  # YYYYMMDD0000
            year = int(data[0:4])
            month = int(data[4:6])
            day = int(data[6:8])
            if 1900 <= year <= 2200 and 1 <= month <= 12 and 1 <= day <= 31:
                return {"type": "day", "year": year, "month": month, "day": day}
        except (ValueError, IndexError):
            pass
    
    # Check for month UUID pattern: 00000000-0000-0000-00aa-YYYYMM000000
    elif uuid.startswith("00000000-0000-0000-00aa-"):
        try:
            data = uuid[-12:]  # YYYYMM000000
            year = int(data[0:4])
            month = int(data[4:6])
            if 1900 <= year <= 2200 and 1 <= month <= 12:
                return {"type": "month", "year": year, "month": month}
        except (ValueError, IndexError):
            pass
    
    # Check for year UUID pattern: 00000000-0000-0000-00bb-YYYY00000000
    elif uuid.startswith("00000000-0000-0000-00bb-"):
        try:
            data = uuid[-12:]  # YYYY00000000
            year = int(data[0:4])
            if 1900 <= year <= 2200:
                return {"type": "year", "year": year}
        except (ValueError, IndexError):
            pass
    
    return None
    
    return None


# System type names - these are created on database initialization
SYSTEM_TYPES = [
    "type",
    "page",
    "year",
    "month",
    "day",
    "quote",
    "query",
    "code",
    "asset",
    "whiteboard",
    "card",
    "task",
    "template",
    "comment",
]

# Default pages created on initialization
DEFAULT_PAGES = [
    "Inbox",
    "Quick Add",
]

# System types with fixed UUIDs (never change these)
SYSTEM_TYPE_UUIDS = {
    "type": "00000000-0000-0000-0001-000000000001",
    "page": "00000000-0000-0000-0001-000000000002",
    "year": "00000000-0000-0000-0001-000000000003",
    "month": "00000000-0000-0000-0001-000000000004",
    "day": "00000000-0000-0000-0001-000000000005",
    "quote": "00000000-0000-0000-0001-000000000006",
    "query": "00000000-0000-0000-0001-000000000007",
    "code": "00000000-0000-0000-0001-000000000008",
    "asset": "00000000-0000-0000-0001-000000000009",
    "whiteboard": "00000000-0000-0000-0001-000000000010",
    "card": "00000000-0000-0000-0001-000000000011",
    "task": "00000000-0000-0000-0001-000000000012",
    "template": "00000000-0000-0000-0001-000000000013",
    "comment": "00000000-0000-0000-0001-000000000014",
}

# Default icons for system types (MDI icon names)
SYSTEM_TYPE_ICONS = {
    "type": "shape",
    "day": "calendar-today",
    "month": "calendar-month",
    "year": "calendar-text",
    "quote": "format-quote-close",
    "query": "magnify",
    "asset": "paperclip",
    "whiteboard": "draw",
    "card": "card-outline",
    "template": "file-document-outline",
    "comment": "comment-outline",
}

# System properties with fixed UUIDs
SYSTEM_PROPERTY_UUIDS = {
    "tags": "00000000-0000-0000-0000-000000000001",
    "types": "00000000-0000-0000-0000-000000000002",
    "show_hierarchy": "00000000-0000-0000-0000-000000000003",
    "used_in": "00000000-0000-0000-0000-000000000004",
    "cover": "00000000-0000-0000-0000-000000000005",
    "banner": "00000000-0000-0000-0000-000000000006",
}

SYSTEM_PROPERTIES = [
    {"name": "tags", "type": "node", "multi": True, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["tags"]},
    {"name": "types", "type": "node", "multi": True, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["types"]},
    {"name": "show_hierarchy", "type": "boolean", "multi": False, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["show_hierarchy"]},
    {"name": "used_in", "type": "node", "multi": True, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["used_in"]},
    {"name": "cover", "type": "node", "multi": False, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["cover"]},
    {"name": "banner", "type": "node", "multi": False, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["banner"]},
]


# ============== PostgreSQL Schema DDL ==============

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


async def init_database(conn: asyncpg.Connection) -> None:
    """Initialize the database with schema.
    
    This creates all tables, indexes, and triggers.
    Call this during application startup.
    """
    # Execute schema
    await conn.execute(SCHEMA_SQL)
    
    # Store schema version
    await conn.execute("""
        INSERT INTO schema_meta (key, value, updated_at) 
        VALUES ('version', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    """, str(SCHEMA_VERSION))


async def seed_workspace(conn: asyncpg.Connection, workspace_id: int) -> None:
    """Seed a workspace with system types, properties, and default pages.
    
    This should be called when creating a new workspace.
    """
    now = datetime.now(timezone.utc)
    
    # Helper to assign a relation property value
    async def assign_relation_property(node_id: int, property_id: int, target_node_id: int, order: int = 0):
        # Create or get node_property assignment
        await conn.execute("""
            INSERT INTO node_property (node_id, property_id, create_date, write_date)
            VALUES ($1, $2, $3, $3)
            ON CONFLICT (node_id, property_id) DO NOTHING
        """, node_id, property_id, now)
        
        # Get node_property id
        np_row = await conn.fetchrow(
            "SELECT id FROM node_property WHERE node_id = $1 AND property_id = $2",
            node_id, property_id
        )
        if np_row is None:
            raise RuntimeError(f"node_property not found for node_id={node_id}, property_id={property_id}")
        node_property_id = np_row['id']
        
        # Insert the relation value
        await conn.execute("""
            INSERT INTO property_value_relation 
            (node_property_id, property_id, node_id, target_node_id, "order", create_date, write_date)
            VALUES ($1, $2, $3, $4, $5, $6, $6)
        """, node_property_id, property_id, node_id, target_node_id, order, now)
    
    # Create 'type' node
    type_uuid = SYSTEM_TYPE_UUIDS["type"]
    type_row = await conn.fetchrow("""
        INSERT INTO node (uuid, workspace_id, name, is_type, is_page, create_date, write_date)
        VALUES ($1, $2, 'type', TRUE, TRUE, $3, $3)
        RETURNING id
    """, type_uuid, workspace_id, now)
    type_node_id = type_row['id']
    
    # Create 'page' type node
    page_uuid = SYSTEM_TYPE_UUIDS["page"]
    page_row = await conn.fetchrow("""
        INSERT INTO node (uuid, workspace_id, name, is_type, is_page, create_date, write_date)
        VALUES ($1, $2, 'page', TRUE, TRUE, $3, $3)
        RETURNING id
    """, page_uuid, workspace_id, now)
    page_type_id = page_row['id']
    
    # Create 'types' property (global, not workspace-specific for now)
    types_prop_uuid = SYSTEM_PROPERTY_UUIDS["types"]
    types_row = await conn.fetchrow("""
        INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date)
        VALUES ($1, 'types', 'node', TRUE, TRUE, $2, $2)
        ON CONFLICT (uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """, types_prop_uuid, now)
    types_property_id = types_row['id']
    
    # Set type filter for 'types' property
    await conn.execute("""
        INSERT INTO property_type_filter (property_id, type_node_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
    """, types_property_id, type_node_id)
    
    # Create other system properties
    show_hier_uuid = SYSTEM_PROPERTY_UUIDS["show_hierarchy"]
    await conn.execute("""
        INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date)
        VALUES ($1, 'show_hierarchy', 'boolean', FALSE, TRUE, $2, $2)
        ON CONFLICT (uuid) DO NOTHING
    """, show_hier_uuid, now)
    
    # Create 'cover' property
    cover_uuid = SYSTEM_PROPERTY_UUIDS["cover"]
    cover_row = await conn.fetchrow("""
        INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date)
        VALUES ($1, 'cover', 'image', FALSE, TRUE, $2, $2)
        ON CONFLICT (uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """, cover_uuid, now)
    cover_property_id = cover_row['id']
    
    # Create 'banner' property
    banner_uuid = SYSTEM_PROPERTY_UUIDS["banner"]
    banner_row = await conn.fetchrow("""
        INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date)
        VALUES ($1, 'banner', 'image', FALSE, TRUE, $2, $2)
        ON CONFLICT (uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """, banner_uuid, now)
    banner_property_id = banner_row['id']
    
    # Assign types to 'type' node
    await assign_relation_property(type_node_id, types_property_id, type_node_id, 0)
    await assign_relation_property(type_node_id, types_property_id, page_type_id, 1)
    
    # Assign types to 'page' node
    await assign_relation_property(page_type_id, types_property_id, type_node_id, 0)
    await assign_relation_property(page_type_id, types_property_id, page_type_id, 1)
    
    # Create remaining system types
    asset_type_id = None
    
    for type_name in SYSTEM_TYPES:
        if type_name in ("type", "page"):
            continue
        
        type_uuid = SYSTEM_TYPE_UUIDS.get(type_name, generate_uuid())
        type_icon = SYSTEM_TYPE_ICONS.get(type_name)
        
        row = await conn.fetchrow("""
            INSERT INTO node (uuid, workspace_id, name, icon, is_type, is_page, create_date, write_date)
            VALUES ($1, $2, $3, $4, TRUE, TRUE, $5, $5)
            RETURNING id
        """, type_uuid, workspace_id, type_name, type_icon, now)
        new_type_id = row['id']
        
        if type_name == "asset":
            asset_type_id = new_type_id
        
        # Assign 'type' and 'page' types
        await assign_relation_property(new_type_id, types_property_id, type_node_id, 0)
        await assign_relation_property(new_type_id, types_property_id, page_type_id, 1)
    
    # Set type filter for 'cover' and 'banner' properties
    if asset_type_id:
        await conn.execute("""
            INSERT INTO property_type_filter (property_id, type_node_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
        """, cover_property_id, asset_type_id)
        await conn.execute("""
            INSERT INTO property_type_filter (property_id, type_node_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
        """, banner_property_id, asset_type_id)
    
    # Create default pages
    for page_name in DEFAULT_PAGES:
        row = await conn.fetchrow("""
            INSERT INTO node (uuid, workspace_id, name, is_page, create_date, write_date)
            VALUES ($1, $2, $3, TRUE, $4, $4)
            RETURNING id
        """, generate_uuid(), workspace_id, page_name, now)
        new_page_id = row['id']
        
        # Assign 'page' type
        await assign_relation_property(new_page_id, types_property_id, page_type_id, 0)


async def create_workspace_for_user(
    conn: asyncpg.Connection,
    user_id: int,
    name: str = "Default"
) -> int:
    """Create a new workspace for a user and seed it with system data.
    
    Returns the workspace ID.
    """
    now = datetime.now(timezone.utc)
    
    # Create workspace
    row = await conn.fetchrow("""
        INSERT INTO workspace (name, owner_id, create_date, write_date)
        VALUES ($1, $2, $3, $3)
        RETURNING id
    """, name, user_id, now)
    workspace_id = row['id']
    
    # Add owner as workspace member
    await conn.execute("""
        INSERT INTO workspace_member (workspace_id, user_id, role, create_date)
        VALUES ($1, $2, 'owner', $3)
    """, workspace_id, user_id, now)
    
    # Seed workspace with system data
    await seed_workspace(conn, workspace_id)
    
    return workspace_id


async def get_or_create_user_workspace(
    conn: asyncpg.Connection,
    user_id: int
) -> int:
    """Get the user's default workspace or create one if it doesn't exist.
    
    Returns the workspace ID.
    """
    # Check for existing workspace
    row = await conn.fetchrow("""
        SELECT w.id FROM workspace w
        JOIN workspace_member wm ON w.id = wm.workspace_id
        WHERE wm.user_id = $1
        ORDER BY w.create_date ASC
        LIMIT 1
    """, user_id)
    
    if row:
        return row['id']
    
    # Create new workspace
    return await create_workspace_for_user(conn, user_id)
