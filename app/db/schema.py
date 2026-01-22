"""Database schema for Notees.

This module defines the SQLite schema and provides initialization functions.
"""
import aiosqlite
from pathlib import Path
from datetime import datetime, timezone, date
from typing import Optional
import uuid as uuid_module

from ..domain.entities import generate_uuid


# Schema version for migrations
SCHEMA_VERSION = 1


def utc_now_iso() -> str:
    """Get current UTC time as ISO string."""
    return datetime.now(timezone.utc).isoformat()


def generate_day_uuid(d: date) -> str:
    """Generate UUID for a day node: YYYYMMDD format."""
    return d.strftime("%Y%m%d")


def generate_month_uuid(year: int, month: int) -> str:
    """Generate UUID for a month node: YYYYMM00 format."""
    return f"{year:04d}{month:02d}00"


def generate_year_uuid(year: int) -> str:
    """Generate UUID for a year node: YYYY0000 format."""
    return f"{year:04d}0000"


def parse_date_uuid(uuid: str) -> Optional[dict]:
    """Parse a date UUID to extract year, month, day.
    
    Returns dict with 'type' ('year', 'month', 'day') and date components.
    Returns None if not a date UUID.
    """
    if not uuid or len(uuid) != 8 or not uuid.isdigit():
        return None
    
    year = int(uuid[0:4])
    month = int(uuid[4:6])
    day = int(uuid[6:8])
    
    if year < 1900 or year > 2200:
        return None
    
    if month == 0 and day == 0:
        return {"type": "year", "year": year}
    elif day == 0 and 1 <= month <= 12:
        return {"type": "month", "year": year, "month": month}
    elif 1 <= month <= 12 and 1 <= day <= 31:
        return {"type": "day", "year": year, "month": month, "day": day}
    
    return None


# System type names - these are created on database initialization
# Types define what kind of node something is (can have multiple types)
SYSTEM_TYPES = [
    "type",     # Meta-type: nodes that define types themselves
    "page",     # Regular pages
    "year",     # Year journal pages
    "month",    # Month journal pages  
    "day",      # Day journal pages
    "quote",    # Quote blocks
    "query",    # Query/search blocks
    "code",     # Code blocks
    "asset",    # Asset/file blocks
    "whiteboard", # Whiteboard pages
    "card",     # Card blocks
    "task",     # Task items
    "template", # Template pages
    "comment",  # Comment blocks attached to nodes
]

# Default pages created on initialization
DEFAULT_PAGES = [
    "Inbox",
    "Quick Add",
]

# System types with fixed UUIDs (never change these - used for lookup in code)
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
# These icons are inherited by nodes of that type if the node has no explicit icon
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

# System properties with fixed UUIDs (never change these - used for filtering in code)
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
    {"name": "used_in", "type": "node", "multi": True, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["used_in"]},  # For templates: tracks nodes created from this template
    {"name": "cover", "type": "node", "multi": False, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["cover"]},  # Cover image (asset node reference)
    {"name": "banner", "type": "node", "multi": False, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["banner"]},  # Banner image (full-width header background)
]


SCHEMA_SQL = """
-- User table
CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    create_date TEXT NOT NULL,
    write_date TEXT NOT NULL
);

-- Node table - the core entity
CREATE TABLE IF NOT EXISTS node (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    icon TEXT,
    color TEXT,
    parent_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    page_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    sequence INTEGER DEFAULT 0,
    collapsed INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    -- Type flags (computed/denormalized for fast queries, not mutually exclusive)
    is_type INTEGER DEFAULT 0,      -- This node defines a type
    is_page INTEGER DEFAULT 0,      -- Regular page
    is_day INTEGER DEFAULT 0,       -- Daily journal page
    is_month INTEGER DEFAULT 0,     -- Monthly journal page
    is_year INTEGER DEFAULT 0,      -- Yearly journal page  
    is_asset INTEGER DEFAULT 0,     -- Asset/file block
    is_template INTEGER DEFAULT 0,  -- Template page
    is_comment INTEGER DEFAULT 0,   -- Comment block
    -- Type-specific fields (only meaningful when is_type = 1)
    usable_in TEXT DEFAULT 'both',  -- Where this type can be applied: 'pages', 'blocks', 'both'
    -- Cover image (references an asset node)
    cover_image_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    -- Types Path: inherited type IDs from ancestors (JSON array, for queries not backlinks)
    types_path TEXT DEFAULT '[]',
    -- Open date: timestamp when page was last opened/viewed (NULL by default, only set for pages when viewed)
    open_date TEXT,
    create_date TEXT NOT NULL,
    write_date TEXT NOT NULL,
    create_uid INTEGER REFERENCES user(id),
    write_uid INTEGER REFERENCES user(id)
);

CREATE INDEX IF NOT EXISTS idx_node_uuid ON node(uuid);
CREATE INDEX IF NOT EXISTS idx_node_parent_id ON node(parent_id);
CREATE INDEX IF NOT EXISTS idx_node_page_id ON node(page_id);
CREATE INDEX IF NOT EXISTS idx_node_name ON node(name);
CREATE INDEX IF NOT EXISTS idx_node_is_page ON node(is_page) WHERE is_page = 1;
CREATE INDEX IF NOT EXISTS idx_node_is_type ON node(is_type) WHERE is_type = 1;
CREATE INDEX IF NOT EXISTS idx_node_is_day ON node(is_day) WHERE is_day = 1;
CREATE INDEX IF NOT EXISTS idx_node_open_date ON node(open_date) WHERE open_date IS NOT NULL;

-- Property table - defines property schemas
-- name uniqueness: Global properties must have unique names
-- Local properties (is_local=1) must have unique names per node_id (which must be a page node)
CREATE TABLE IF NOT EXISTS property (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    icon TEXT,
    type TEXT NOT NULL DEFAULT 'text',  -- integer, float, boolean (scalar) | node, text, image, date (relation) | selection
    is_multi INTEGER DEFAULT 0,  -- Allow multiple values (always 0 for text/image types)
    is_system INTEGER DEFAULT 0,
    is_local INTEGER DEFAULT 0,  -- Local properties are unique per node_id, not globally
    node_id INTEGER REFERENCES node(id) ON DELETE CASCADE,  -- For local properties: the page node this belongs to
    create_date TEXT NOT NULL,
    write_date TEXT NOT NULL,
    -- Constraint: node_id can only be set if is_local=1
    CHECK (is_local = 1 OR node_id IS NULL),
    -- Constraint: text and image types are always single value
    CHECK (type NOT IN ('text', 'image') OR is_multi = 0)
);

CREATE INDEX IF NOT EXISTS idx_property_uuid ON property(uuid);
CREATE INDEX IF NOT EXISTS idx_property_name ON property(name);
CREATE INDEX IF NOT EXISTS idx_property_node_id ON property(node_id) WHERE node_id IS NOT NULL;
-- Unique constraint for global properties (non-local)
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_global ON property(name) WHERE is_local = 0;
-- Unique constraint for local properties (unique name per node_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_local ON property(name, node_id) WHERE is_local = 1;

-- Node property assignment table - links properties to nodes (without values)
CREATE TABLE IF NOT EXISTS node_property (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    create_date TEXT NOT NULL,
    write_date TEXT NOT NULL,
    UNIQUE(node_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_node_property_node ON node_property(node_id);
CREATE INDEX IF NOT EXISTS idx_node_property_property ON node_property(property_id);

-- Property value scalar - for integer, float, boolean types
-- property_id and node_id are computed from node_property for query convenience
CREATE TABLE IF NOT EXISTS property_value_scalar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_property_id INTEGER NOT NULL REFERENCES node_property(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL,  -- Computed from node_property
    node_id INTEGER NOT NULL,  -- Computed from node_property
    value_text TEXT,
    value_boolean INTEGER,
    value_float REAL,
    value_integer INTEGER,
    "order" INTEGER DEFAULT 0,  -- For multi-value properties
    create_date TEXT NOT NULL,
    write_date TEXT NOT NULL,
    FOREIGN KEY (property_id) REFERENCES property(id) ON DELETE CASCADE,
    FOREIGN KEY (node_id) REFERENCES node(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pvs_node_property ON property_value_scalar(node_property_id);
CREATE INDEX IF NOT EXISTS idx_pvs_property ON property_value_scalar(property_id);
CREATE INDEX IF NOT EXISTS idx_pvs_node ON property_value_scalar(node_id);

-- Property value relation - for node, text, image, date types
-- property_id and node_id are computed from node_property for query convenience
-- For text/image types: target_node_id points to a content block that:
--   - Can only be assigned to ONE property_value (enforced in application, not schema)
--   - Has page_id computed from node_property.node_id
--   - Does not require parent_id (like pages)
--   - Gets deleted when the property_value is removed
-- For node/date types: target_node_id can be referenced by multiple property values
CREATE TABLE IF NOT EXISTS property_value_relation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_property_id INTEGER NOT NULL REFERENCES node_property(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL,  -- Computed from node_property
    node_id INTEGER NOT NULL,  -- Computed from node_property
    target_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    "order" INTEGER DEFAULT 0,  -- For multi-value properties
    create_date TEXT NOT NULL,
    write_date TEXT NOT NULL,
    FOREIGN KEY (property_id) REFERENCES property(id) ON DELETE CASCADE,
    FOREIGN KEY (node_id) REFERENCES node(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pvr_node_property ON property_value_relation(node_property_id);
CREATE INDEX IF NOT EXISTS idx_pvr_property ON property_value_relation(property_id);
CREATE INDEX IF NOT EXISTS idx_pvr_node ON property_value_relation(node_id);
CREATE INDEX IF NOT EXISTS idx_pvr_target ON property_value_relation(target_node_id);

-- Property selection line - options for selection-type properties
-- Cannot be deleted if used in property_value_selection (enforced in application)
-- Cascade deleted when parent property is deleted
CREATE TABLE IF NOT EXISTS property_selection_line (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT,
    "order" INTEGER DEFAULT 0,
    create_date TEXT NOT NULL,
    write_date TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_selection_line_property ON property_selection_line(property_id);

-- Property value selection - for selection-type properties
-- property_id and node_id are computed from node_property for query convenience
CREATE TABLE IF NOT EXISTS property_value_selection (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_property_id INTEGER NOT NULL REFERENCES node_property(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL,  -- Computed from node_property
    node_id INTEGER NOT NULL,  -- Computed from node_property
    selection_line_id INTEGER NOT NULL REFERENCES property_selection_line(id) ON DELETE RESTRICT,
    "order" INTEGER DEFAULT 0,  -- For multi-value properties
    create_date TEXT NOT NULL,
    write_date TEXT NOT NULL,
    FOREIGN KEY (property_id) REFERENCES property(id) ON DELETE CASCADE,
    FOREIGN KEY (node_id) REFERENCES node(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pvsel_node_property ON property_value_selection(node_property_id);
CREATE INDEX IF NOT EXISTS idx_pvsel_property ON property_value_selection(property_id);
CREATE INDEX IF NOT EXISTS idx_pvsel_node ON property_value_selection(node_id);
CREATE INDEX IF NOT EXISTS idx_pvsel_selection_line ON property_value_selection(selection_line_id);

-- Property type filters (for node-type properties - which types filter selectable nodes)
CREATE TABLE IF NOT EXISTS property_type_filter (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    UNIQUE(property_id, type_node_id)
);

CREATE INDEX IF NOT EXISTS idx_type_filter_property ON property_type_filter(property_id);

-- Type properties (which properties a type/class applies to nodes with that type)
CREATE TABLE IF NOT EXISTS type_property (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    sequence INTEGER DEFAULT 0,
    hidden INTEGER DEFAULT 0,
    default_integer INTEGER,
    default_float REAL,
    default_text TEXT,
    default_boolean INTEGER,
    default_node_id INTEGER REFERENCES node(id),
    default_selection_id INTEGER REFERENCES property_selection_line(id),
    UNIQUE(type_node_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_type_property_type ON type_property(type_node_id);
CREATE INDEX IF NOT EXISTS idx_type_property_property ON type_property(property_id);

-- Type extends (inheritance - which types a type extends to inherit their properties)
CREATE TABLE IF NOT EXISTS type_extends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    extends_type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    sequence INTEGER DEFAULT 0,
    UNIQUE(type_node_id, extends_type_node_id)
);

CREATE INDEX IF NOT EXISTS idx_type_extends_type ON type_extends(type_node_id);
CREATE INDEX IF NOT EXISTS idx_type_extends_parent ON type_extends(extends_type_node_id);

-- Node links (parsed from node name field or property values) - unified [[nodeId]] format
-- For text links: source_node_id = block T containing [[id]], property_id = NULL
-- For property links: source_node_id = property owner B, property_id = the property
-- System property 'types' is excluded from this table entirely
-- is_tag: If true, this link is a tag reference (displayed with #) rather than a regular link
CREATE TABLE IF NOT EXISTS node_link (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    property_id INTEGER REFERENCES property(id) ON DELETE CASCADE,
    is_tag INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_link_source ON node_link(source_node_id);
CREATE INDEX IF NOT EXISTS idx_link_target ON node_link(target_node_id);
CREATE INDEX IF NOT EXISTS idx_link_property ON node_link(property_id) WHERE property_id IS NOT NULL;

-- Inline type references (parsed from node name field) - {{typeId}} format
-- Stores inline type mentions in block content, similar to node_link but for types
-- source_node_id = block containing {{typeId}}, type_node_id = the type node being referenced
CREATE TABLE IF NOT EXISTS inline_type (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inline_type_source ON inline_type(source_node_id);
CREATE INDEX IF NOT EXISTS idx_inline_type_target ON inline_type(type_node_id);

-- Node comments (comments attached to nodes - each comment is a node tree)
CREATE TABLE IF NOT EXISTS node_comment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    comment_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    sequence INTEGER DEFAULT 0,
    create_date TEXT NOT NULL,
    UNIQUE(node_id, comment_node_id)
);

CREATE INDEX IF NOT EXISTS idx_comment_node ON node_comment(node_id);
CREATE INDEX IF NOT EXISTS idx_comment_comment_node ON node_comment(comment_node_id);

-- User settings (key-value store for user preferences)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Node activity log (tracks actions on nodes)
CREATE TABLE IF NOT EXISTS node_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    details TEXT,
    target_node_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    create_date TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_node ON node_activity(node_id);
CREATE INDEX IF NOT EXISTS idx_activity_create_date ON node_activity(create_date);

-- Link click tracking (stores individual clicks with timestamps)
CREATE TABLE IF NOT EXISTS link_click (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    click_date TEXT NOT NULL,
    user_id INTEGER REFERENCES user(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_link_click_source ON link_click(source_node_id);
CREATE INDEX IF NOT EXISTS idx_link_click_target ON link_click(target_node_id);
CREATE INDEX IF NOT EXISTS idx_link_click_date ON link_click(click_date);
CREATE INDEX IF NOT EXISTS idx_link_click_source_target ON link_click(source_node_id, target_node_id);

-- Schema metadata
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


async def init_database(db_path: Path) -> aiosqlite.Connection:
    """Initialize the database with schema and seed data."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    
    conn = await aiosqlite.connect(str(db_path))
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA busy_timeout = 5000")  # Wait up to 5 seconds if locked
    
    # Create schema
    await conn.executescript(SCHEMA_SQL)
    
    # Check if already seeded
    cursor = await conn.execute(
        "SELECT value FROM schema_meta WHERE key = 'seeded'"
    )
    row = await cursor.fetchone()
    
    if not row:
        # Seed new database first
        await seed_database(conn)
        await conn.execute(
            "INSERT INTO schema_meta (key, value) VALUES ('seeded', '1')"
        )
        await conn.commit()
    
    # Run migrations for existing databases (after seed, so we don't conflict)
    await run_migrations(conn)
    
    # Store schema version
    await conn.execute(
        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)",
        (str(SCHEMA_VERSION),)
    )
    
    await conn.commit()
    return conn


async def run_migrations(conn: aiosqlite.Connection) -> None:
    """Run database migrations for existing databases."""
    # Migration: Add usable_in column to node table if it doesn't exist
    cursor = await conn.execute("PRAGMA table_info(node)")
    columns = await cursor.fetchall()
    column_names = [col['name'] for col in columns]
    
    if 'usable_in' not in column_names:
        await conn.execute("ALTER TABLE node ADD COLUMN usable_in TEXT DEFAULT 'both'")
        await conn.commit()
    
    # Migration: Create node_activity table if it doesn't exist
    cursor = await conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='node_activity'"
    )
    if not await cursor.fetchone():
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS node_activity (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
                action TEXT NOT NULL,
                details TEXT,
                target_node_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
                create_date TEXT NOT NULL
            )
        """)
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_activity_node ON node_activity(node_id)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_activity_create_date ON node_activity(create_date)")
        await conn.commit()
    
    # Migration: Create link_click table if it doesn't exist (new schema with individual clicks)
    cursor = await conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='link_click'"
    )
    if not await cursor.fetchone():
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS link_click (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
                target_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
                click_date TEXT NOT NULL,
                user_id INTEGER REFERENCES user(id) ON DELETE SET NULL
            )
        """)
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_link_click_source ON link_click(source_node_id)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_link_click_target ON link_click(target_node_id)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_link_click_date ON link_click(click_date)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_link_click_source_target ON link_click(source_node_id, target_node_id)")
        await conn.commit()
    else:
        # Migration: Convert old link_click table (with click_count) to new schema (individual clicks)
        cursor = await conn.execute("PRAGMA table_info(link_click)")
        columns = await cursor.fetchall()
        column_names = [col['name'] for col in columns]
        
        if 'click_count' in column_names:
            # Old schema detected - migrate to new schema
            # First, backup old data
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS link_click_old AS SELECT * FROM link_click
            """)
            # Drop old table
            await conn.execute("DROP TABLE link_click")
            # Create new table
            await conn.execute("""
                CREATE TABLE link_click (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
                    target_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
                    click_date TEXT NOT NULL,
                    user_id INTEGER REFERENCES user(id) ON DELETE SET NULL
                )
            """)
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_link_click_source ON link_click(source_node_id)")
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_link_click_target ON link_click(target_node_id)")
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_link_click_date ON link_click(click_date)")
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_link_click_source_target ON link_click(source_node_id, target_node_id)")
            # Migrate old data - create one click record per count with last_click_date
            await conn.execute("""
                INSERT INTO link_click (source_node_id, target_node_id, click_date)
                SELECT source_node_id, target_node_id, last_click_date 
                FROM link_click_old
            """)
            # Drop backup
            await conn.execute("DROP TABLE link_click_old")
            await conn.commit()
    
    # Migration: Add cover_image_id column to node table if it doesn't exist
    cursor = await conn.execute("PRAGMA table_info(node)")
    columns = await cursor.fetchall()
    column_names = [col['name'] for col in columns]
    
    if 'cover_image_id' not in column_names:
        await conn.execute("ALTER TABLE node ADD COLUMN cover_image_id INTEGER REFERENCES node(id) ON DELETE SET NULL")
        await conn.commit()
    
    # Migration: Add 'cover' system property if it doesn't exist
    cursor = await conn.execute(
        "SELECT id FROM property WHERE uuid = ?",
        (SYSTEM_PROPERTY_UUIDS["cover"],)
    )
    row = await cursor.fetchone()
    if not row:
        # Create the cover property
        now = utc_now_iso()
        cursor = await conn.execute(
            """INSERT INTO property (uuid, name, type, multi, is_system, create_date, write_date)
               VALUES (?, 'cover', 'node', 0, 1, ?, ?)""",
            (SYSTEM_PROPERTY_UUIDS["cover"], now, now)
        )
        cover_property_id = cursor.lastrowid
        
        # Get asset type ID for type filter
        cursor = await conn.execute(
            "SELECT id FROM node WHERE name = 'asset' AND is_type = 1 LIMIT 1"
        )
        asset_row = await cursor.fetchone()
        if asset_row:
            await conn.execute(
                """INSERT INTO property_type_filter (property_id, type_node_id)
                   VALUES (?, ?)""",
                (cover_property_id, asset_row['id'])
            )
        
        await conn.commit()
    
    # Migration: Add 'banner' system property if it doesn't exist
    cursor = await conn.execute(
        "SELECT id FROM property WHERE uuid = ?",
        (SYSTEM_PROPERTY_UUIDS["banner"],)
    )
    row = await cursor.fetchone()
    if not row:
        # Create the banner property
        now = utc_now_iso()
        cursor = await conn.execute(
            """INSERT INTO property (uuid, name, type, multi, is_system, create_date, write_date)
               VALUES (?, 'banner', 'node', 0, 1, ?, ?)""",
            (SYSTEM_PROPERTY_UUIDS["banner"], now, now)
        )
        banner_property_id = cursor.lastrowid
        
        # Get asset type ID for type filter
        cursor = await conn.execute(
            "SELECT id FROM node WHERE name = 'asset' AND is_type = 1 LIMIT 1"
        )
        asset_row = await cursor.fetchone()
        if asset_row:
            await conn.execute(
                """INSERT INTO property_type_filter (property_id, type_node_id)
                   VALUES (?, ?)""",
                (banner_property_id, asset_row['id'])
            )
        
        await conn.commit()
    
    # Migration: Add open_date column to node table if it doesn't exist
    cursor = await conn.execute("PRAGMA table_info(node)")
    columns = await cursor.fetchall()
    column_names = [col['name'] for col in columns]
    
    if 'open_date' not in column_names:
        await conn.execute("ALTER TABLE node ADD COLUMN open_date TEXT")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_node_open_date ON node(open_date) WHERE open_date IS NOT NULL")
        await conn.commit()
    
    # Migration: Ensure system type nodes have create_date and write_date set
    # This fixes any system nodes that may have been created with empty dates
    now = utc_now_iso()
    await conn.execute("""
        UPDATE node 
        SET create_date = ?, write_date = ?
        WHERE is_type = 1 AND (create_date IS NULL OR create_date = '' OR write_date IS NULL OR write_date = '')
    """, (now, now))
    await conn.commit()


async def seed_database(conn: aiosqlite.Connection) -> None:
    """Seed the database with system types, properties, and default pages."""
    now = utc_now_iso()
    
    # Helper function to assign a relation property value to a node
    async def assign_relation_property(node_id: int, property_id: int, target_node_id: int, order: int = 0):
        """Assign a relation property value to a node using the new schema."""
        # First create or get node_property assignment
        cursor = await conn.execute(
            """INSERT OR IGNORE INTO node_property (node_id, property_id, create_date, write_date)
               VALUES (?, ?, ?, ?)""",
            (node_id, property_id, now, now)
        )
        # Get the node_property id
        cursor = await conn.execute(
            "SELECT id FROM node_property WHERE node_id = ? AND property_id = ?",
            (node_id, property_id)
        )
        np_row = await cursor.fetchone()
        if np_row is None:
            raise RuntimeError(f"node_property not found for node_id={node_id}, property_id={property_id}")
        node_property_id = np_row['id']
        
        # Insert the relation value
        await conn.execute(
            """INSERT INTO property_value_relation 
               (node_property_id, property_id, node_id, target_node_id, "order", create_date, write_date)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (node_property_id, property_id, node_id, target_node_id, order, now, now)
        )
    
    # First, create the 'type' and 'page' type nodes using fixed UUIDs
    type_uuid = SYSTEM_TYPE_UUIDS["type"]
    page_uuid = SYSTEM_TYPE_UUIDS["page"]
    
    # Create 'type' node (the meta-type - it IS a type itself)
    cursor = await conn.execute(
        """INSERT INTO node (uuid, name, is_type, is_page, create_date, write_date)
           VALUES (?, 'type', 1, 1, ?, ?)""",
        (type_uuid, now, now)
    )
    type_node_id = cursor.lastrowid
    assert type_node_id is not None, "Failed to insert type node"
    
    # Create 'page' type node (also a type, and a page)
    cursor = await conn.execute(
        """INSERT INTO node (uuid, name, is_type, is_page, create_date, write_date)
           VALUES (?, 'page', 1, 1, ?, ?)""",
        (page_uuid, now, now)
    )
    page_type_id = cursor.lastrowid
    assert page_type_id is not None, "Failed to insert page type node"
    
    # Create 'types' property (node type, multi, filtered by 'type')
    # Use fixed UUID for system property identification
    types_prop_uuid = SYSTEM_PROPERTY_UUIDS["types"]
    cursor = await conn.execute(
        """INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date)
           VALUES (?, 'types', 'node', 1, 1, ?, ?)""",
        (types_prop_uuid, now, now)
    )
    types_property_id = cursor.lastrowid
    assert types_property_id is not None, "Failed to insert types property"
    
    # Set type filter for 'types' property to 'type' node
    await conn.execute(
        """INSERT INTO property_type_filter (property_id, type_node_id)
           VALUES (?, ?)""",
        (types_property_id, type_node_id)
    )
    
    # Create 'show_hierarchy' boolean property
    # Use fixed UUID for system property identification
    show_hier_uuid = SYSTEM_PROPERTY_UUIDS["show_hierarchy"]
    await conn.execute(
        """INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date)
           VALUES (?, 'show_hierarchy', 'boolean', 0, 1, ?, ?)""",
        (show_hier_uuid, now, now)
    )
    
    # Create 'cover' property (image type - single value, filtered by 'asset' - filter added later)
    # Use fixed UUID for system property identification
    cover_uuid = SYSTEM_PROPERTY_UUIDS["cover"]
    cursor = await conn.execute(
        """INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date)
           VALUES (?, 'cover', 'image', 0, 1, ?, ?)""",
        (cover_uuid, now, now)
    )
    cover_property_id = cursor.lastrowid
    
    # Create 'banner' property (image type - single value, filtered by 'asset' - filter added later)
    # Use fixed UUID for system property identification
    banner_uuid = SYSTEM_PROPERTY_UUIDS["banner"]
    cursor = await conn.execute(
        """INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date)
           VALUES (?, 'banner', 'image', 0, 1, ?, ?)""",
        (banner_uuid, now, now)
    )
    banner_property_id = cursor.lastrowid
    
    # Assign types to 'type' node (it is a type and a page)
    await assign_relation_property(type_node_id, types_property_id, type_node_id, 0)
    await assign_relation_property(type_node_id, types_property_id, page_type_id, 1)
    
    # Assign types to 'page' node (it is a type and a page)
    await assign_relation_property(page_type_id, types_property_id, type_node_id, 0)
    await assign_relation_property(page_type_id, types_property_id, page_type_id, 1)
    
    # Create remaining system types (all are types and pages)
    # Some types (day, month, year) have default icons that nodes inherit
    asset_type_id = None  # Track asset type ID for cover property filter
    
    for type_name in SYSTEM_TYPES:
        if type_name in ("type", "page"):
            continue  # Already created
        
        # Use fixed UUID for system types
        type_uuid = SYSTEM_TYPE_UUIDS.get(type_name, generate_uuid())
        
        # Get default icon for this type (if any)
        type_icon = SYSTEM_TYPE_ICONS.get(type_name)
        
        # All system types are type definitions and pages
        # The is_type and is_page flags are set because they have 'type' and 'page' types assigned
        # Other flags (is_day, is_month, etc.) should NOT be set on the type definition itself -
        # those flags are only set on nodes that have that type assigned to them
        cursor = await conn.execute(
            """INSERT INTO node (uuid, name, icon, is_type, is_page, create_date, write_date)
               VALUES (?, ?, ?, 1, 1, ?, ?)""",
            (type_uuid, type_name, type_icon, now, now)
        )
        new_type_id = cursor.lastrowid
        assert new_type_id is not None, f"Failed to insert {type_name} type node"
        
        # Track asset type ID for cover property filter
        if type_name == "asset":
            asset_type_id = new_type_id
        
        # Assign 'type' and 'page' types
        await assign_relation_property(new_type_id, types_property_id, type_node_id, 0)
        await assign_relation_property(new_type_id, types_property_id, page_type_id, 1)
    
    # Set type filter for 'cover' property to 'asset' node
    if asset_type_id:
        await conn.execute(
            """INSERT INTO property_type_filter (property_id, type_node_id)
               VALUES (?, ?)""",
            (cover_property_id, asset_type_id)
        )
    
    # Set type filter for 'banner' property to 'asset' node
    if asset_type_id:
        await conn.execute(
            """INSERT INTO property_type_filter (property_id, type_node_id)
               VALUES (?, ?)""",
            (banner_property_id, asset_type_id)
        )
    
    # Create default pages (have is_page=1, type is 'page')
    # Icons are intentionally left empty - views should show default MDI icons
    
    for page_name in DEFAULT_PAGES:
        cursor = await conn.execute(
            """INSERT INTO node (uuid, name, is_page, create_date, write_date)
               VALUES (?, ?, 1, ?, ?)""",
            (generate_uuid(), page_name, now, now)
        )
        new_page_id = cursor.lastrowid
        assert new_page_id is not None, f"Failed to insert {page_name} page"
        
        # Assign 'page' type only
        await assign_relation_property(new_page_id, types_property_id, page_type_id, 0)
    
    await conn.commit()


async def get_database(db_path: Path) -> aiosqlite.Connection:
    """Get a database connection, initializing if needed."""
    if not db_path.exists():
        return await init_database(db_path)
    
    conn = await aiosqlite.connect(str(db_path))
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA busy_timeout = 5000")  # Wait up to 5 seconds if locked
    return conn
