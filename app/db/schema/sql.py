"""PostgreSQL DDL schema for Notees.

This module contains the raw SQL schema definition for creating all database
tables, indexes, and triggers used by the relay-based architecture.

SCHEMA VERSION: 5 - Legacy node/property/asset tables removed.
"""

from pathlib import Path

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
    totp_secret TEXT,
    totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    totp_enabled_at TIMESTAMPTZ,
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

-- Backup codes for TOTP two-factor authentication (one row per code)
CREATE TABLE IF NOT EXISTS user_backup_code (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_backup_code_user ON user_backup_code(user_id);

-- Push notification device tokens (one row per user/device pair)
CREATE TABLE IF NOT EXISTS user_device_token (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    platform VARCHAR(20) NOT NULL DEFAULT 'unknown',
    active BOOLEAN DEFAULT TRUE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, token)
);

CREATE INDEX IF NOT EXISTS idx_user_device_token_user_id ON user_device_token(user_id);
CREATE INDEX IF NOT EXISTS idx_user_device_token_token ON user_device_token(token);

-- ============================================================
-- WORKSPACES
-- ============================================================

CREATE TABLE IF NOT EXISTS workspace (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    active BOOLEAN DEFAULT TRUE,
    is_shared BOOLEAN DEFAULT FALSE,
    sync_protocol_version VARCHAR(10) NOT NULL DEFAULT 'v2',
    restore_epoch INTEGER NOT NULL DEFAULT 0,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_workspace_sync_protocol_version CHECK (sync_protocol_version IN ('v1', 'v2'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_create_uid ON workspace(create_uid);
CREATE INDEX IF NOT EXISTS idx_workspace_write_uid ON workspace(write_uid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_name_per_user ON workspace(name, create_uid) WHERE active = TRUE;

-- Workspace sharing with granular permissions
CREATE TABLE IF NOT EXISTS workspace_share (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
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
-- SHARES & INVITES
-- ============================================================

-- Per-node sharing with granular permissions. node_uuid is a logical reference
-- to a node in the operation-log derived state; no foreign key is enforced.
CREATE TABLE IF NOT EXISTS node_share (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    node_uuid UUID NOT NULL,
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
    UNIQUE(node_uuid, user_id)
);

-- Public share links (tokenized anonymous access)
CREATE TABLE IF NOT EXISTS node_public_share (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    node_uuid UUID NOT NULL,
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expiry_date TIMESTAMPTZ,
    password_hash TEXT,
    active BOOLEAN DEFAULT TRUE
);

-- ============================================================
-- MIGRATION: SHARE METADATA FROM INTEGER node_id TO node_uuid
-- ============================================================

-- One-way migration for pre-existing databases that still use the legacy
-- integer node_id column in share metadata tables. New databases skip this
-- block because node_id does not exist on those tables. The node table is
-- only referenced when the legacy column still exists, so dropping node
-- later via drop_legacy_tables is safe.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node_public_share' AND column_name = 'node_id'
    ) THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'node_public_share' AND column_name = 'node_uuid'
        ) THEN
            ALTER TABLE node_public_share ADD COLUMN node_uuid UUID;
        END IF;

        UPDATE node_public_share s
        SET node_uuid = n.uuid
        FROM node n
        WHERE n.id = s.node_id;

        IF EXISTS (SELECT 1 FROM node_public_share WHERE node_uuid IS NULL) THEN
            RAISE EXCEPTION 'node_public_share rows exist with unmapped node_id values';
        END IF;

        ALTER TABLE node_public_share ALTER COLUMN node_uuid SET NOT NULL;
        ALTER TABLE node_public_share DROP COLUMN node_id CASCADE;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node_share' AND column_name = 'node_id'
    ) THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'node_share' AND column_name = 'node_uuid'
        ) THEN
            ALTER TABLE node_share ADD COLUMN node_uuid UUID;
        END IF;

        UPDATE node_share s
        SET node_uuid = n.uuid
        FROM node n
        WHERE n.id = s.node_id;

        IF EXISTS (SELECT 1 FROM node_share WHERE node_uuid IS NULL) THEN
            RAISE EXCEPTION 'node_share rows exist with unmapped node_id values';
        END IF;

        ALTER TABLE node_share ALTER COLUMN node_uuid SET NOT NULL;
        ALTER TABLE node_share DROP COLUMN node_id CASCADE;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'pending_invite' AND column_name = 'node_id'
    ) THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'pending_invite' AND column_name = 'node_uuid'
        ) THEN
            ALTER TABLE pending_invite ADD COLUMN node_uuid UUID;
        END IF;

        UPDATE pending_invite i
        SET node_uuid = n.uuid
        FROM node n
        WHERE n.id = i.node_id;

        IF EXISTS (SELECT 1 FROM pending_invite WHERE node_uuid IS NULL AND node_id IS NOT NULL) THEN
            RAISE EXCEPTION 'pending_invite rows exist with unmapped node_id values';
        END IF;

        ALTER TABLE pending_invite ALTER COLUMN node_uuid SET NOT NULL;
        ALTER TABLE pending_invite DROP COLUMN node_id CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_node_share_node ON node_share(node_uuid);
CREATE INDEX IF NOT EXISTS idx_node_share_user_id ON node_share(user_id);

CREATE INDEX IF NOT EXISTS idx_node_public_share_uuid ON node_public_share(uuid);
CREATE INDEX IF NOT EXISTS idx_node_public_share_node ON node_public_share(node_uuid) WHERE active = TRUE;

-- Pending invites (for users who don't have an account yet)
CREATE TABLE IF NOT EXISTS pending_invite (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL,
    workspace_id INTEGER REFERENCES workspace(id) ON DELETE CASCADE,
    node_uuid UUID NOT NULL,
    role VARCHAR(20) DEFAULT 'viewer',
    invited_by INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    active BOOLEAN DEFAULT TRUE,
    UNIQUE(email, workspace_id, node_uuid)
);

CREATE INDEX IF NOT EXISTS idx_pending_invite_email ON pending_invite(email);
CREATE INDEX IF NOT EXISTS idx_pending_invite_uuid ON pending_invite(uuid);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS notification (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    actor_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    node_uuid UUID,
    message TEXT,
    is_read BOOLEAN DEFAULT FALSE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_user_unread ON notification(user_id, is_read) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_notification_user_date ON notification(user_id, create_date DESC);

-- Migration: notification FROM INTEGER node_id TO node_uuid
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'notification' AND column_name = 'node_id'
    ) THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'notification' AND column_name = 'node_uuid'
        ) THEN
            ALTER TABLE notification ADD COLUMN node_uuid UUID;
        END IF;

        UPDATE notification ntf
        SET node_uuid = n.uuid
        FROM node n
        WHERE n.id = ntf.node_id;

        ALTER TABLE notification DROP COLUMN node_id CASCADE;
    END IF;
END $$;

-- ============================================================
-- SETTINGS
-- ============================================================

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

CREATE TABLE IF NOT EXISTS setting_system (
    key VARCHAR(255) NOT NULL PRIMARY KEY,
    value JSONB,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SCHEMA METADATA
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_meta (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

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
    rotated_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    replaced_by INTEGER REFERENCES refresh_token(id) ON DELETE SET NULL,
    family_id UUID NOT NULL DEFAULT uuid_generate_v4(),
    remember_me BOOLEAN NOT NULL DEFAULT FALSE,
    grace_period_used BOOLEAN NOT NULL DEFAULT FALSE,
    last_4 VARCHAR(4)
);

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

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'refresh_token' AND column_name = 'rotated_at'
    ) THEN
        ALTER TABLE refresh_token ADD COLUMN rotated_at TIMESTAMPTZ;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'refresh_token' AND column_name = 'grace_period_used'
    ) THEN
        ALTER TABLE refresh_token ADD COLUMN grace_period_used BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_refresh_token_user ON refresh_token(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_token_hash ON refresh_token(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_token_family ON refresh_token(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_token_last4 ON refresh_token(last_4);
CREATE INDEX IF NOT EXISTS idx_refresh_token_remember_me ON refresh_token(remember_me) WHERE remember_me = TRUE;

-- ============================================================
-- TRIGGERS
-- ============================================================

CREATE OR REPLACE FUNCTION update_write_date()
RETURNS TRIGGER AS $$
BEGIN
    NEW.write_date := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
"""

# Append the relay storage schema maintained in a dedicated SQL file.
SCHEMA_SQL += (Path(__file__).parent / "relay.sql").read_text()
