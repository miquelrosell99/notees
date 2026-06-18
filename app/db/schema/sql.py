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
-- ============================================================
-- CORE IDENTITY & ACCESS
-- ============================================================

-- User table (global, not per workspace)
CREATE TABLE IF NOT EXISTS "user" (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name VARCHAR(255),
    surnames VARCHAR(255),
    profile_pic TEXT,
    role VARCHAR(20) DEFAULT 'user',
    active BOOLEAN DEFAULT TRUE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration: Rename username to email and add profile fields
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user' AND column_name = 'username'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user' AND column_name = 'email'
    ) THEN
        ALTER TABLE "user" RENAME COLUMN username TO email;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user' AND column_name = 'name'
    ) THEN
        ALTER TABLE "user" ADD COLUMN name VARCHAR(255);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user' AND column_name = 'surnames'
    ) THEN
        ALTER TABLE "user" ADD COLUMN surnames VARCHAR(255);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user' AND column_name = 'profile_pic'
    ) THEN
        ALTER TABLE "user" ADD COLUMN profile_pic TEXT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user' AND column_name = 'role'
    ) THEN
        ALTER TABLE "user" ADD COLUMN role VARCHAR(20) DEFAULT 'user';
    END IF;
END $$;

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
    can_comment BOOLEAN DEFAULT FALSE,
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
    sequence DOUBLE PRECISION DEFAULT 0.0,
    collapsed BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    is_shared BOOLEAN NOT NULL DEFAULT FALSE,
    version INTEGER DEFAULT 1,
    -- Soft delete fields
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    -- Class flags (denormalized for fast queries)
    is_class BOOLEAN NOT NULL DEFAULT FALSE,
    is_page BOOLEAN NOT NULL DEFAULT FALSE,
    is_day BOOLEAN NOT NULL DEFAULT FALSE,
    is_month BOOLEAN NOT NULL DEFAULT FALSE,
    is_year BOOLEAN NOT NULL DEFAULT FALSE,
    is_asset BOOLEAN NOT NULL DEFAULT FALSE,
    is_template BOOLEAN NOT NULL DEFAULT FALSE,
    is_comment BOOLEAN NOT NULL DEFAULT FALSE,
    is_task BOOLEAN NOT NULL DEFAULT FALSE,
    is_table BOOLEAN NOT NULL DEFAULT FALSE,
    -- Parent lock flag
    parent_locked BOOLEAN NOT NULL DEFAULT FALSE,
    -- Privacy: if true, only the owner can access this node
    is_private BOOLEAN NOT NULL DEFAULT FALSE,
    -- Class IDs stored directly on the node
    class_ids INTEGER[] DEFAULT '{}',
    -- Tag IDs stored directly on the node (mirrors class_ids)
    tag_ids INTEGER[] DEFAULT '{}',
    classes_path JSONB DEFAULT '[]'::jsonb,
    open_date TIMESTAMPTZ,
    -- Alias support: if set, this node is an alias of the referenced node
    aliased_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    -- Full-text search
    search_vector tsvector,
    search_text TEXT,
    search_language VARCHAR(50) DEFAULT 'english',
    -- Audit
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

-- Ensure columns referenced by the indexes below exist on databases created
-- before these columns were added to the CREATE TABLE statement.  Without
-- these guards, CREATE INDEX on a pre-existing node table that is missing a
-- column fails with "column does not exist" before the later migration blocks
-- have a chance to run.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node' AND column_name = 'is_task'
    ) THEN
        ALTER TABLE node ADD COLUMN is_task BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node' AND column_name = 'is_table'
    ) THEN
        ALTER TABLE node ADD COLUMN is_table BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node' AND column_name = 'tag_ids'
    ) THEN
        ALTER TABLE node ADD COLUMN tag_ids INTEGER[] DEFAULT '{}';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node' AND column_name = 'search_text'
    ) THEN
        ALTER TABLE node ADD COLUMN search_text TEXT;
    END IF;
END $$;

-- Node indexes
CREATE INDEX IF NOT EXISTS idx_node_workspace_id ON node(workspace_id);
CREATE INDEX IF NOT EXISTS idx_node_uuid ON node(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_uuid_per_workspace ON node(workspace_id, uuid);
CREATE INDEX IF NOT EXISTS idx_node_parent_id ON node(parent_id);
CREATE INDEX IF NOT EXISTS idx_node_page_id ON node(page_id);
CREATE INDEX IF NOT EXISTS idx_node_page_sequence ON node(page_id, sequence);
CREATE INDEX IF NOT EXISTS idx_node_page_content ON node(page_id, sequence)
INCLUDE (id, uuid, icon, color, parent_id, collapsed, active, class_ids)
WHERE active = TRUE AND is_deleted = FALSE AND is_comment = FALSE;
CREATE INDEX IF NOT EXISTS idx_node_is_private ON node(workspace_id, is_private) WHERE active = TRUE AND is_deleted = FALSE;
-- HASH index: node names can be large AST JSON blobs exceeding B-tree's 2704-byte limit.
-- HASH supports equality lookups; use idx_node_search (GIN/FTS) for text search.
CREATE INDEX IF NOT EXISTS idx_node_name ON node USING HASH (name);
CREATE INDEX IF NOT EXISTS idx_node_is_page ON node(is_page) WHERE is_page = TRUE;
-- Composite: fast "list all pages in workspace" queries filtered to active, non-deleted nodes
CREATE INDEX IF NOT EXISTS idx_node_workspace_is_page ON node(workspace_id, is_page) WHERE active = TRUE AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_node_is_class ON node(is_class) WHERE is_class = TRUE;
CREATE INDEX IF NOT EXISTS idx_node_is_day ON node(is_day) WHERE is_day = TRUE;
-- Composite: fast daily-journal lookups scoped to a specific workspace
CREATE INDEX IF NOT EXISTS idx_node_workspace_is_day ON node(workspace_id, is_day) WHERE is_day = TRUE;
CREATE INDEX IF NOT EXISTS idx_node_open_date ON node(open_date) WHERE open_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_node_is_deleted ON node(is_deleted) WHERE is_deleted = TRUE;
CREATE INDEX IF NOT EXISTS idx_node_is_task ON node(is_task) WHERE is_task = TRUE;
-- Composite: fast task lookups scoped to a specific workspace
CREATE INDEX IF NOT EXISTS idx_node_workspace_is_task ON node(workspace_id, is_task) WHERE active = TRUE AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_node_is_table ON node(is_table) WHERE is_table = TRUE;
-- Composite: fast table lookups scoped to a specific workspace
CREATE INDEX IF NOT EXISTS idx_node_workspace_is_table ON node(workspace_id, is_table) WHERE active = TRUE AND is_deleted = FALSE;
-- Partial index covering all live (active, non-deleted) nodes - matches the most common query predicate.
-- Enables fast index-only scans when filtering out soft-deleted rows without a full table scan.
CREATE INDEX IF NOT EXISTS idx_node_live ON node(workspace_id, id) WHERE active = TRUE AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_node_class_ids ON node USING GIN (class_ids);
CREATE INDEX IF NOT EXISTS idx_node_tag_ids ON node USING GIN (tag_ids);
CREATE INDEX IF NOT EXISTS idx_node_classes_path ON node USING GIN (classes_path);
CREATE INDEX IF NOT EXISTS idx_node_search ON node USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_node_search_text ON node USING GIN (to_tsvector('english', COALESCE(search_text, '')));
CREATE INDEX IF NOT EXISTS idx_node_create_uid ON node(create_uid);
CREATE INDEX IF NOT EXISTS idx_node_write_uid ON node(write_uid);
-- Index for ordering children by sequence within a parent
CREATE INDEX IF NOT EXISTS idx_node_parent_sequence ON node(parent_id, sequence);
-- Workspace-scoped child listing with order: covers WHERE workspace_id = ? AND parent_id = ? ORDER BY sequence
CREATE INDEX IF NOT EXISTS idx_node_ws_parent_sequence ON node(workspace_id, parent_id, sequence) WHERE active = TRUE AND is_deleted = FALSE;
-- Partial indexes for specific node types (Phase 0.1: Data Model Hardening)
CREATE INDEX IF NOT EXISTS idx_node_pages ON node(workspace_id, name) WHERE is_page = TRUE AND active = TRUE AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_node_blocks ON node(workspace_id, parent_id, sequence) WHERE is_page = FALSE AND active = TRUE AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_node_assets ON node(workspace_id, name) WHERE is_asset = TRUE AND active = TRUE AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_node_templates ON node(workspace_id, name) WHERE is_template = TRUE AND active = TRUE AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_node_comments ON node(workspace_id, parent_id) WHERE is_comment = TRUE AND active = TRUE AND is_deleted = FALSE;

-- Note: idx_node_aliased_id is created by migration block below (aliased_id may not exist on older DBs)
-- Note: Page name uniqueness per class is enforced at application level
-- Database only enforces basic structure, complex class-based uniqueness in Python

-- user_page_node_id is added after node table creation to avoid circular dependency
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS user_page_node_id INTEGER REFERENCES node(id) ON DELETE SET NULL;

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
    can_comment BOOLEAN DEFAULT FALSE,
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

-- Public share links (tokenized anonymous access)
CREATE TABLE IF NOT EXISTS node_public_share (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expiry_date TIMESTAMPTZ,
    password_hash TEXT,
    active BOOLEAN DEFAULT TRUE,
    UNIQUE(node_id, uuid)
);

CREATE INDEX IF NOT EXISTS idx_node_public_share_uuid ON node_public_share(uuid);
CREATE INDEX IF NOT EXISTS idx_node_public_share_node ON node_public_share(node_id) WHERE active = TRUE;

-- Pending invites (for users who don't have an account yet)
CREATE TABLE IF NOT EXISTS pending_invite (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL,
    workspace_id INTEGER REFERENCES workspace(id) ON DELETE CASCADE,
    node_id INTEGER REFERENCES node(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'viewer',
    invited_by INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    active BOOLEAN DEFAULT TRUE,
    UNIQUE(email, workspace_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_pending_invite_email ON pending_invite(email);
CREATE INDEX IF NOT EXISTS idx_pending_invite_uuid ON pending_invite(uuid);

-- Notifications (mentions, shares, comments)
CREATE TABLE IF NOT EXISTS notification (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    actor_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    node_id INTEGER REFERENCES node(id) ON DELETE CASCADE,
    message TEXT,
    is_read BOOLEAN DEFAULT FALSE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_user_unread ON notification(user_id, is_read) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_notification_user_date ON notification(user_id, create_date DESC);

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
    scope VARCHAR(20) NOT NULL DEFAULT 'global',
    node_id INTEGER REFERENCES node(id) ON DELETE CASCADE,
    icon_visibility VARCHAR(50) DEFAULT 'hidden',
    active BOOLEAN DEFAULT TRUE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    CHECK (scope = 'global' OR node_id IS NOT NULL),
    CHECK (type NOT IN ('image') OR is_multi = FALSE)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_property_workspace_uuid ON property(workspace_id, uuid);
CREATE INDEX IF NOT EXISTS idx_property_name ON property(name);
CREATE INDEX IF NOT EXISTS idx_property_workspace_id ON property(workspace_id);
CREATE INDEX IF NOT EXISTS idx_property_node_id ON property(node_id) WHERE node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_property_create_uid ON property(create_uid);
CREATE INDEX IF NOT EXISTS idx_property_write_uid ON property(write_uid);
-- Unique constraint for global properties (name unique per workspace)
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_global ON property(name, workspace_id)
    WHERE scope = 'global' AND active = TRUE;
-- Unique constraint for scoped properties (class or node): unique name per node_id+scope
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_name_scoped ON property(name, node_id, scope)
    WHERE scope != 'global' AND active = TRUE;

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

-- Property value scalar - for integer, float, boolean, date types
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
-- Covering indexes for common EAV filter: WHERE property_id = ? AND value = ? -> node_id covered
CREATE INDEX IF NOT EXISTS idx_pvs_property_value_text ON property_value_scalar(property_id, value_text, node_id) WHERE value_text IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pvs_property_value_int ON property_value_scalar(property_id, value_integer, node_id) WHERE value_integer IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pvs_property_value_float ON property_value_scalar(property_id, value_float, node_id) WHERE value_float IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pvs_property_value_bool ON property_value_scalar(property_id, value_boolean, node_id) WHERE value_boolean IS NOT NULL;

-- Property value relation - for node, text, image relation types
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
-- Covering indexes: filter by property+target, get node_id without heap fetch (forward + reverse)
CREATE INDEX IF NOT EXISTS idx_pvr_property_target_node ON property_value_relation(property_id, target_id, node_id);
CREATE INDEX IF NOT EXISTS idx_pvr_property_node_target ON property_value_relation(property_id, node_id, target_id);

-- Property selection line - options for selection-type properties
CREATE TABLE IF NOT EXISTS property_selection_line (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    icon VARCHAR(100),
    sequence INTEGER NOT NULL DEFAULT 0,
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
-- Covering index: filter nodes by property + selected option, node_id covered (no heap fetch)
CREATE INDEX IF NOT EXISTS idx_pvsel_property_line_node ON property_value_selection(property_id, selection_line_id, node_id);

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
    is_embed BOOLEAN DEFAULT FALSE,
    name TEXT,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_node_link_source_id ON node_link(source_id);
CREATE INDEX IF NOT EXISTS idx_node_link_target_id ON node_link(target_id);
CREATE INDEX IF NOT EXISTS idx_node_link_workspace_id ON node_link(workspace_id);
CREATE INDEX IF NOT EXISTS idx_node_link_property_id ON node_link(property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_node_link_source_target ON node_link(source_id, target_id);
-- Composite: fast workspace-scoped backlink queries ("who links to X in this workspace?")
CREATE INDEX IF NOT EXISTS idx_node_link_workspace_target ON node_link(workspace_id, target_id);
-- Covering traversal index: (ws, source) filters, target_id is index-covered (no heap fetch).
-- Highest-ROI index for graph-heavy (Obsidian-style) forward-traversal queries:
--   SELECT target_id FROM node_link WHERE workspace_id = ? AND source_id = ?;
CREATE INDEX IF NOT EXISTS idx_node_link_ws_source_target ON node_link(workspace_id, source_id, target_id);

-- Ensure is_embed column exists for databases created before embed backlinks.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node_link' AND column_name = 'is_embed'
    ) THEN
        ALTER TABLE node_link ADD COLUMN is_embed BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Unique constraint: prevent duplicate links between the same source and target.
-- Embeds and inline classes are distinct from regular text links, so they are
-- included in the uniqueness key. PostgreSQL treats NULLs as distinct, so
-- property_id does not need to be coalesced.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'unique_node_link' AND conrelid = 'node_link'::regclass
    ) THEN
        ALTER TABLE node_link DROP CONSTRAINT unique_node_link;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'unique_node_link_typed' AND conrelid = 'node_link'::regclass
    ) THEN
        ALTER TABLE node_link ADD CONSTRAINT unique_node_link_typed
            UNIQUE (workspace_id, source_id, target_id, property_id, is_inline_class, is_embed);
    END IF;
END $$;

-- idx_node_link_inline_class is created in the migration block below (safe for existing DBs)

-- Inline class references are now stored in node_link with is_inline_class = TRUE
-- (class_inline table has been merged into node_link)

-- ============================================================
-- NODE MENTIONS (UNLINKED MENTION CANDIDATES)
-- ============================================================
-- Tracks occurrences of a page name in another page's content that are not yet
-- explicit links. Used to power the "Unlinked Mentions" panel.

CREATE TABLE IF NOT EXISTS node_mention (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    source_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    match_text TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    is_ignored BOOLEAN DEFAULT FALSE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_node_mention_source_id ON node_mention(source_id);
CREATE INDEX IF NOT EXISTS idx_node_mention_target_id ON node_mention(target_id);
CREATE INDEX IF NOT EXISTS idx_node_mention_workspace_id ON node_mention(workspace_id);
CREATE INDEX IF NOT EXISTS idx_node_mention_workspace_target ON node_mention(workspace_id, target_id)
    WHERE is_ignored = FALSE;

ALTER TABLE node_mention DROP CONSTRAINT IF EXISTS unique_node_mention;
ALTER TABLE node_mention ADD CONSTRAINT unique_node_mention
    UNIQUE (workspace_id, source_id, target_id, position);

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

-- System settings (global key-value store)
CREATE TABLE IF NOT EXISTS setting_system (
    key VARCHAR(255) NOT NULL PRIMARY KEY,
    value JSONB,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
-- NODE VERSION HISTORY
-- ============================================================

-- Stores snapshots of node content for version history / undo
CREATE TABLE IF NOT EXISTS node_version (
    id SERIAL PRIMARY KEY,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_node_version_node_id ON node_version(node_id);
CREATE INDEX IF NOT EXISTS idx_node_version_created_at ON node_version(created_at);

-- Trigger function: capture node content before update (when name or class changes)
-- (Phase 0: broadened from name-only to catch all meaningful edits)
CREATE OR REPLACE FUNCTION capture_node_version()
RETURNS TRIGGER AS $fn$
BEGIN
    -- Capture when name, class, or structural properties change
    IF OLD.name IS DISTINCT FROM NEW.name
       OR OLD.class_ids IS DISTINCT FROM NEW.class_ids
       OR OLD.tag_ids IS DISTINCT FROM NEW.tag_ids
       OR OLD.parent_id IS DISTINCT FROM NEW.parent_id
       OR OLD.page_id IS DISTINCT FROM NEW.page_id
    THEN
        INSERT INTO node_version (node_id, workspace_id, name, created_at, user_id)
        VALUES (OLD.id, OLD.workspace_id, OLD.name, NOW(), NEW.write_uid);
    END IF;
    RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

-- Attach trigger (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_node_version_capture'
    ) THEN
        CREATE TRIGGER trg_node_version_capture
            BEFORE UPDATE ON node
            FOR EACH ROW
            EXECUTE FUNCTION capture_node_version();
    END IF;
END $$;

-- Migration: Drop version column from node_version (no longer needed, we use created_at)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'node_version' AND column_name = 'version') THEN
        ALTER TABLE node_version DROP COLUMN version;
    END IF;
END $$;

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

-- Migration: Add is_task column to node table if missing
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'node' AND column_name = 'is_task') THEN
        ALTER TABLE node ADD COLUMN is_task BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

-- Migration: Add is_table column to node table if missing
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'node' AND column_name = 'is_table') THEN
        ALTER TABLE node ADD COLUMN is_table BOOLEAN NOT NULL DEFAULT FALSE;
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

-- ============================================================
-- MIGRATION: TAGS FROM node_link TO node.tag_ids
-- ============================================================

-- Migration: Add tag_ids column to node table and migrate existing tag links
DO $$
BEGIN
    -- Add tag_ids column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node' AND column_name = 'tag_ids'
    ) THEN
        ALTER TABLE node ADD COLUMN tag_ids INTEGER[] DEFAULT '{}';
    END IF;

    -- Populate tag_ids from existing node_link.is_tag rows (one-time migration)
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node_link' AND column_name = 'is_tag'
    ) THEN
        UPDATE node n
        SET tag_ids = COALESCE((
            SELECT ARRAY_AGG(DISTINCT target_id ORDER BY target_id)
            FROM node_link nl
            WHERE nl.source_id = n.id
              AND nl.is_tag = TRUE
              AND nl.property_id IS NULL
              AND nl.workspace_id = n.workspace_id
        ), '{}'::INTEGER[])
        WHERE n.tag_ids = '{}'::INTEGER[]
          AND EXISTS (
              SELECT 1 FROM node_link nl2
              WHERE nl2.source_id = n.id
                AND nl2.is_tag = TRUE
                AND nl2.property_id IS NULL
          );
    END IF;

    -- Create GIN index for tag_ids if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'idx_node_tag_ids'
    ) THEN
        CREATE INDEX idx_node_tag_ids ON node USING GIN (tag_ids);
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

-- Migration: Add aliased_id column to node table for alias support
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node' AND column_name = 'aliased_id'
    ) THEN
        ALTER TABLE node ADD COLUMN aliased_id INTEGER REFERENCES node(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_node_aliased_id ON node(aliased_id) WHERE aliased_id IS NOT NULL;
    END IF;
END $$;

-- Ensure aliased_id index exists (safe to run even if column was just created)
CREATE INDEX IF NOT EXISTS idx_node_aliased_id ON node(aliased_id) WHERE aliased_id IS NOT NULL;

-- Migration: Clean up any self-referencing aliases and add CHECK constraint to prevent them
DO $$
BEGIN
    -- Fix any existing self-references (shouldn't happen, but ensures constraint can be added)
    UPDATE node SET aliased_id = NULL WHERE aliased_id = id;

    -- Add CHECK constraint preventing a node from being an alias of itself
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_node_no_self_alias'
          AND conrelid = 'node'::regclass
    ) THEN
        ALTER TABLE node ADD CONSTRAINT chk_node_no_self_alias
            CHECK (aliased_id IS NULL OR aliased_id != id);
    END IF;
END $$;

-- Migration: Add sequence column to property_selection_line for manual ordering
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'property_selection_line' AND column_name = 'sequence'
    ) THEN
        ALTER TABLE property_selection_line ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
    END IF;
END $$;

-- Migration: Update property CHECK constraint to allow multi text properties
-- Old constraint: CHECK (type NOT IN ('text', 'image') OR is_multi = FALSE)
-- New constraint: CHECK (type NOT IN ('image') OR is_multi = FALSE)
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    -- Find and drop old CHECK constraint that blocks multi text
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'property'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%text%image%is_multi%';

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE property DROP CONSTRAINT %I', constraint_name);
        ALTER TABLE property ADD CHECK (type NOT IN ('image') OR is_multi = FALSE);
    END IF;
END $$;

-- Migration: Create 'Description' system property for all existing workspaces
DO $$
DECLARE
    ws RECORD;
BEGIN
    FOR ws IN SELECT id FROM workspace LOOP
        INSERT INTO property (uuid, workspace_id, name, type, is_multi, is_system, create_date, write_date)
        VALUES ('00000000-0000-0000-0000-000000000009', ws.id, 'Description', 'text', TRUE, TRUE, NOW(), NOW())
        ON CONFLICT (workspace_id, uuid) DO NOTHING;
    END LOOP;
END $$;

-- Migration: Replace B-tree idx_node_name with HASH index to avoid
-- "index row size exceeds btree maximum" errors when node names are large AST blobs.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'idx_node_name'
          AND indexdef NOT ILIKE '%using hash%'
    ) THEN
        DROP INDEX IF EXISTS idx_node_name;
        CREATE INDEX idx_node_name ON node USING HASH (name);
    END IF;
END $$;

-- Migration: Rename 'Scheduled' property to 'Scheduled Date' in all workspaces
DO $$
BEGIN
    UPDATE property
    SET name = 'Scheduled Date', write_date = NOW()
    WHERE uuid = '00000000-0000-0000-0003-000000000003' AND name = 'Scheduled';
END $$;

-- Migration: Create 'Closed Date' property for task class in all existing workspaces
DO $$
DECLARE
    ws RECORD;
    task_class_id integer;
    prop_id integer;
BEGIN
    FOR ws IN SELECT id FROM workspace LOOP
        -- Get the task class node ID for this workspace
        SELECT n.id INTO task_class_id
        FROM node n
        WHERE n.workspace_id = ws.id AND n.uuid = '00000000-0000-0000-0001-000000000012' AND n.active = TRUE
        LIMIT 1;

        -- Insert the Closed Date property
        INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, create_date, write_date)
        VALUES ('00000000-0000-0000-0003-000000000005', ws.id, 'Closed Date', 'calendar-remove', 'date', FALSE, FALSE, NOW(), NOW())
        ON CONFLICT (workspace_id, uuid) DO NOTHING
        RETURNING id INTO prop_id;

        -- If the property was just created and the task class exists, link it
        IF prop_id IS NOT NULL AND task_class_id IS NOT NULL THEN
            INSERT INTO class_property (class_node_id, property_id, sequence)
            VALUES (task_class_id, prop_id, 4)
            ON CONFLICT (class_node_id, property_id) DO NOTHING;
        -- If property already existed, ensure it's linked to the task class
        ELSIF task_class_id IS NOT NULL THEN
            SELECT id INTO prop_id FROM property
            WHERE workspace_id = ws.id AND uuid = '00000000-0000-0000-0003-000000000005'
            LIMIT 1;
            IF prop_id IS NOT NULL THEN
                INSERT INTO class_property (class_node_id, property_id, sequence)
                VALUES (task_class_id, prop_id, 4)
                ON CONFLICT (class_node_id, property_id) DO NOTHING;
            END IF;
        END IF;
    END LOOP;
END $$;

-- ============================================================
-- MIGRATIONS: PROPERTY MANAGEMENT UX OVERHAUL (Phase 1-4)
-- ============================================================

-- Migration: Add color column to property_selection_line (replaces JSON-in-icon hack)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'property_selection_line' AND column_name = 'color'
    ) THEN
        ALTER TABLE property_selection_line ADD COLUMN color VARCHAR(50) DEFAULT NULL;
    END IF;
END $$;

-- Migration: Add validation_rules JSONB column to property
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'property' AND column_name = 'validation_rules'
    ) THEN
        ALTER TABLE property ADD COLUMN validation_rules JSONB DEFAULT NULL;
    END IF;
END $$;

-- Migration: Add required column to class_property
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'class_property' AND column_name = 'required'
    ) THEN
        ALTER TABLE class_property ADD COLUMN required BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Migration: Add sequence and hidden columns to node_property for per-page ordering
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node_property' AND column_name = 'sequence'
    ) THEN
        ALTER TABLE node_property ADD COLUMN sequence INTEGER DEFAULT 0;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node_property' AND column_name = 'hidden'
    ) THEN
        ALTER TABLE node_property ADD COLUMN hidden BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Migration: Add parent_locked column to node table
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node' AND column_name = 'parent_locked'
    ) THEN
        ALTER TABLE node ADD COLUMN parent_locked BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- ============================================================
-- TASK RECURRENCE
-- ============================================================

CREATE TABLE IF NOT EXISTS task_recurrence (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    task_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    rule_type VARCHAR(50) NOT NULL,
    interval INTEGER NOT NULL DEFAULT 1,
    weekdays SMALLINT[],
    day_of_month SMALLINT,
    week_of_month SMALLINT,
    month SMALLINT,
    end_after_count INTEGER,
    end_date DATE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    UNIQUE(task_node_id)
);

CREATE INDEX IF NOT EXISTS idx_task_recurrence_task_node_id ON task_recurrence(task_node_id);
CREATE INDEX IF NOT EXISTS idx_task_recurrence_workspace_id ON task_recurrence(workspace_id);

CREATE TABLE IF NOT EXISTS task_completion (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    task_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    scheduled_date DATE,
    deadline_date DATE,
    status VARCHAR(50) NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_by INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_completion_task_node_id ON task_completion(task_node_id);
CREATE INDEX IF NOT EXISTS idx_task_completion_workspace_id ON task_completion(workspace_id);
CREATE INDEX IF NOT EXISTS idx_task_completion_completed_at ON task_completion(completed_at DESC);

-- ============================================================
-- SCHEMA METADATA
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_meta (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- GET_BREADCRUMBS FUNCTION
-- ============================================================
-- Returns ordered list of nodes from root (or enter_node) down to exit_node.
-- Uses recursive CTE on the adjacency list (parent_id) for ancestor lookup.
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
    WITH RECURSIVE breadcrumbs AS (
        -- Start at the exit node (depth 0)
        SELECT n.id, n.parent_id, 0 AS depth
        FROM node n
        WHERE n.id = exit_node_id AND n.active = TRUE

        UNION ALL

        -- Walk up the parent chain
        SELECT n.id, n.parent_id, b.depth + 1
        FROM node n
        JOIN breadcrumbs b ON n.id = b.parent_id
        WHERE n.active = TRUE
    )
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
        b.depth
    FROM breadcrumbs b
    JOIN node n ON n.id = b.id
    WHERE (
        enter_node_id IS NULL
        OR b.depth <= (SELECT depth FROM breadcrumbs WHERE id = enter_node_id)
    )
    ORDER BY b.depth DESC;  -- Root first (highest depth), exit_node last (depth 0)
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
-- Fire on any column change so search_vector stays current when content changes
-- (Phase 0.7: Fix search_vector trigger scope)
CREATE TRIGGER node_search_update
    BEFORE INSERT OR UPDATE ON node
    FOR EACH ROW
    EXECUTE FUNCTION update_node_search_vector();

-- ============================================================
-- MATERIALIZED search_text COLUMN
-- ============================================================

-- Extract plain text from a node name (handles AST JSON or raw text).
CREATE OR REPLACE FUNCTION node_plain_text(p_name TEXT)
RETURNS TEXT AS $$
DECLARE
    v_result TEXT;
BEGIN
    IF p_name IS NOT NULL AND p_name LIKE '[%' THEN
        BEGIN
            SELECT COALESCE(string_agg(t #>> '{}', ''), '') INTO v_result
            FROM jsonb_path_query(p_name::jsonb, '$.**.text') AS t;
        EXCEPTION WHEN OTHERS THEN
            v_result := COALESCE(p_name, '');
        END;
    ELSE
        v_result := COALESCE(p_name, '');
    END IF;
    RETURN v_result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Compute search_text for a node: own plain text plus recursively resolved
-- outgoing link target names and custom link labels.  Recursion is capped at
-- depth 5 to avoid runaway cycles.
CREATE OR REPLACE FUNCTION compute_node_search_text(p_node_id INTEGER)
RETURNS TEXT AS $$
DECLARE
    v_own TEXT;
    v_links TEXT;
BEGIN
    SELECT node_plain_text(name) INTO v_own
    FROM node WHERE id = p_node_id;

    WITH RECURSIVE link_path(source_id, target_id, link_name, depth) AS (
        SELECT nl.source_id, nl.target_id, nl.name, 1
        FROM node_link nl
        WHERE nl.source_id = p_node_id AND nl.is_inline_class = FALSE
        UNION ALL
        SELECT lp.source_id, nl.target_id, nl.name, lp.depth + 1
        FROM link_path lp
        JOIN node_link nl ON nl.source_id = lp.target_id
        WHERE nl.is_inline_class = FALSE AND lp.depth < 5
    )
    SELECT COALESCE(string_agg(part, ' '), '') INTO v_links
    FROM (
        SELECT DISTINCT node_plain_text(n.name) AS part
        FROM link_path lp
        JOIN node n ON n.id = lp.target_id
        WHERE n.name IS NOT NULL
        UNION
        SELECT DISTINCT lp.link_name AS part
        FROM link_path lp
        WHERE lp.link_name IS NOT NULL
    ) t;

    RETURN COALESCE(v_own, '') || ' ' || v_links;
END;
$$ LANGUAGE plpgsql STABLE;

-- For newly inserted rows the row does not exist during BEFORE INSERT, so
-- compute and store the value after the insert.
CREATE OR REPLACE FUNCTION node_search_text_after_insert()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE node SET search_text = compute_node_search_text(NEW.id) WHERE id = NEW.id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS node_search_text_insert_trigger ON node;
CREATE TRIGGER node_search_text_insert_trigger
    AFTER INSERT ON node
    FOR EACH ROW
    EXECUTE FUNCTION node_search_text_after_insert();

-- After a node's name is updated, recompute its own search_text and the
-- search_text of all nodes that directly link to it.
CREATE OR REPLACE FUNCTION node_search_text_after_update()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE node SET search_text = compute_node_search_text(NEW.id) WHERE id = NEW.id;
    UPDATE node n
    SET search_text = compute_node_search_text(n.id)
    WHERE n.id IN (
        SELECT source_id FROM node_link
        WHERE target_id = NEW.id AND is_inline_class = FALSE
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS node_search_text_after_update_trigger ON node;
CREATE TRIGGER node_search_text_after_update_trigger
    AFTER UPDATE OF name ON node
    FOR EACH ROW
    EXECUTE FUNCTION node_search_text_after_update();

-- Maintain search_text when outgoing links change.
CREATE OR REPLACE FUNCTION node_link_search_text_change()
RETURNS TRIGGER AS $$
DECLARE
    v_source_id INTEGER;
    v_old_source_id INTEGER;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_source_id := OLD.source_id;
        v_old_source_id := NULL;
    ELSE
        v_source_id := NEW.source_id;
        v_old_source_id := OLD.source_id;
    END IF;

    UPDATE node SET search_text = compute_node_search_text(v_source_id) WHERE id = v_source_id;

    IF TG_OP = 'UPDATE' AND v_old_source_id IS DISTINCT FROM v_source_id THEN
        UPDATE node SET search_text = compute_node_search_text(v_old_source_id) WHERE id = v_old_source_id;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS node_link_search_text_trigger ON node_link;
CREATE TRIGGER node_link_search_text_trigger
    AFTER INSERT OR UPDATE OR DELETE ON node_link
    FOR EACH ROW
    EXECUTE FUNCTION node_link_search_text_change();

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
--   WITH RECURSIVE descendants AS (
--       SELECT id FROM node WHERE id = 45
--       UNION ALL
--       SELECT n.id FROM node n
--       JOIN descendants d ON n.parent_id = d.id
--   )
--   SELECT n.* FROM descendants d
--   JOIN node n ON n.id = d.id
--   WHERE d.id != 45;
--
-- Example 5: Check if node A is an ancestor of node B
--   WITH RECURSIVE ancestors AS (
--       SELECT id, parent_id FROM node WHERE id = B
--       UNION ALL
--       SELECT n.id, n.parent_id FROM node n
--       JOIN ancestors a ON n.id = a.parent_id
--   )
--   SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = A);

-- ============================================================
-- UNDO / REDO LOG
-- ============================================================

CREATE TABLE IF NOT EXISTS undo_log (
    id          BIGSERIAL PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL,
    operation   TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   INTEGER NOT NULL,
    before_state JSONB,
    after_state  JSONB,
    description  TEXT,
    is_undone    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_undo_log_stack
    ON undo_log (workspace_id, user_id, created_at DESC)
    WHERE is_undone = FALSE;

CREATE INDEX IF NOT EXISTS idx_undo_log_redo
    ON undo_log (workspace_id, user_id, created_at DESC)
    WHERE is_undone = TRUE;

-- ============================================================
-- API KEYS (device access for background tasks)
-- ============================================================

CREATE TABLE IF NOT EXISTS api_key (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    key_hash TEXT NOT NULL,
    scopes JSONB DEFAULT '["read", "write"]',
    key_prefix VARCHAR(8),
    last_4 VARCHAR(4),
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    revoked BOOLEAN DEFAULT FALSE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration: add expires_at, last_4, and key_prefix if they don't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'api_key' AND column_name = 'expires_at'
    ) THEN
        ALTER TABLE api_key ADD COLUMN expires_at TIMESTAMPTZ;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'api_key' AND column_name = 'last_4'
    ) THEN
        ALTER TABLE api_key ADD COLUMN last_4 VARCHAR(4);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'api_key' AND column_name = 'key_prefix'
    ) THEN
        ALTER TABLE api_key ADD COLUMN key_prefix VARCHAR(8);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_api_key_user_id ON api_key(user_id);
CREATE INDEX IF NOT EXISTS idx_api_key_revoked ON api_key(revoked) WHERE revoked = FALSE;
CREATE INDEX IF NOT EXISTS idx_api_key_expires_at ON api_key(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_api_key_prefix_last4 ON api_key(key_prefix, last_4);

-- ============================================================
-- REFRESH TOKENS
-- ============================================================

CREATE TABLE IF NOT EXISTS refresh_token (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    replaced_by INTEGER REFERENCES refresh_token(id) ON DELETE SET NULL,
    family_id UUID NOT NULL DEFAULT uuid_generate_v4(),
    remember_me BOOLEAN NOT NULL DEFAULT FALSE,
    last_4 VARCHAR(4)
);

-- Migration: Add remember_me and last_4 columns to refresh_token for existing databases
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'refresh_token' AND column_name = 'remember_me'
    ) THEN
        ALTER TABLE refresh_token ADD COLUMN remember_me BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'refresh_token' AND column_name = 'last_4'
    ) THEN
        ALTER TABLE refresh_token ADD COLUMN last_4 VARCHAR(4);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_refresh_token_user ON refresh_token(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_token_hash ON refresh_token(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_token_family ON refresh_token(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_token_last4 ON refresh_token(last_4);
CREATE INDEX IF NOT EXISTS idx_refresh_token_remember_me ON refresh_token(remember_me) WHERE remember_me = TRUE;

-- Migration: Change node.sequence from INTEGER to DOUBLE PRECISION for fractional ordering
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node' AND column_name = 'sequence'
          AND data_type = 'integer'
    ) THEN
        ALTER TABLE node ALTER COLUMN sequence TYPE DOUBLE PRECISION USING sequence::double precision;
    END IF;
END $$;
"""
