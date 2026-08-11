"""Database initialization and seeding functions for Notees.

This module contains functions for initializing the database schema
and creating workspaces. All node/property state lives in the operation log;
only user, workspace, sharing, notification, auth, settings and relay tables
remain in PostgreSQL.

SCHEMA VERSION: 5 - Legacy node/property/asset tables removed.
"""

from __future__ import annotations

from datetime import UTC, datetime

import asyncpg

from ..connection import setup_jsonb_codec
from .constants import SCHEMA_VERSION
from .sql import SCHEMA_SQL


async def init_database(conn: asyncpg.Connection) -> None:
    """Initialize the database with schema.

    This creates all tables, indexes, and triggers used by the relay-based
    architecture. Call this during application startup.
    """
    # Ensure JSONB values are read/written as native Python objects on this
    # connection as well as on pooled connections.
    await setup_jsonb_codec(conn)

    # Keep the UUID extension in a dedicated schema so that recreating the
    # public schema between tests (DROP SCHEMA public CASCADE) does not
    # invalidate the extension catalog entry and leave uuid_generate_v4()
    # intermittently unresolved.
    await conn.execute("CREATE SCHEMA IF NOT EXISTS extensions")
    await conn.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA extensions')

    # Ensure every connection resolves unqualified uuid_generate_v4() against
    # the extensions schema, including ad-hoc connections that do not run
    # through our pool init hook.
    db_name = await conn.fetchval("SELECT current_database()")
    await conn.execute(f'ALTER DATABASE "{db_name}" SET search_path = public, extensions')

    # Execute the schema DDL inside an explicit transaction.  Wrapping the
    # script guarantees it is committed atomically and avoids the subtle
    # uvloop/pytest-asyncio behaviour where a large implicit-transaction
    # multi-statement string is not always persisted.
    async with conn.transaction():
        # Re-bind search_path inside the transaction so uuid_generate_v4() and
        # other extension functions are resolvable even after public was
        # recreated. SET LOCAL keeps the change scoped to this transaction.
        await conn.execute("SET LOCAL search_path TO public, extensions")
        await conn.execute(SCHEMA_SQL)

    # Diagnostic: ensure schema_meta was created by SCHEMA_SQL in public schema
    schema_meta_exists = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_meta')"
    )
    if not schema_meta_exists:
        tables = await conn.fetch(
            "SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = 'schema_meta' ORDER BY table_schema"
        )
        raise RuntimeError(
            f"schema_meta missing in public after SCHEMA_SQL. schema_meta rows: {[(r['table_schema'], r['table_name']) for r in tables]}"
        )

    # Store schema version
    await conn.execute(
        """
        INSERT INTO schema_meta (key, value, updated_at)
        VALUES ('version', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    """,
        str(SCHEMA_VERSION),
    )

    # Run idempotent data migrations once per database
    await _run_migration("migrate_collaboration_schema", conn, _migrate_collaboration_schema)
    await _run_migration("seed_system_settings", conn, _seed_system_settings)
    await _run_migration("add_user_device_token", conn, _add_user_device_token)
    await _run_migration("add_uuid_columns_to_remaining_tables", conn, _add_uuid_columns_to_remaining_tables)
    await _run_migration("add_sync_protocol_version", conn, _add_sync_protocol_version)
    await _run_migration("set_sync_protocol_version_v2_default", conn, _set_sync_protocol_version_v2_default)
    await _run_migration("normalize_settings_jsonb", conn, _normalize_settings_jsonb)
    await _run_migration("add_totp_2fa", conn, _add_totp_2fa)
    await _run_migration("drop_legacy_tables", conn, _run_drop_legacy_tables)
    await _run_migration("add_workspace_restore_epoch", conn, _add_workspace_restore_epoch)
    await _run_migration("normalize_node_link_uuids", conn, _normalize_node_link_uuids)
    await _run_migration("repair_node_link_payload_strings", conn, _repair_node_link_payload_strings)
    await _run_migration("strip_page_class_from_class_ids", conn, _strip_page_class_from_class_ids)


async def _strip_page_class_from_class_ids(conn: asyncpg.Connection) -> None:
    """Strip the legacy page system class UUID from all workspace derived DBs."""
    from app.db.migrations.strip_page_class_from_class_ids import run

    await run(conn)


async def _add_workspace_restore_epoch(conn: asyncpg.Connection) -> None:
    """Add restore_epoch column to workspace for safe backup restoration."""
    has_col = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workspace' AND column_name = 'restore_epoch')"
    )
    if not has_col:
        await conn.execute("ALTER TABLE workspace ADD COLUMN restore_epoch INTEGER NOT NULL DEFAULT 0")


async def _normalize_node_link_uuids(conn: asyncpg.Connection) -> None:
    """Assign stable link-instance UUIDs to legacy bare-target inline links."""
    from app.db.migrations.normalize_node_link_uuids import run

    await run(conn)


async def _repair_node_link_payload_strings(conn: asyncpg.Connection) -> None:
    """Repair payloads that were accidentally stored as JSON strings."""
    from app.db.migrations.repair_node_link_payload_strings import run

    await run(conn)


async def _run_drop_legacy_tables(conn: asyncpg.Connection) -> None:
    """Drop legacy node/property/asset tables that are no longer used."""
    from app.db.migrations.drop_legacy_tables import run

    await run(conn)


async def _run_migration(
    name: str,
    conn: asyncpg.Connection,
    callback: callable,
) -> None:
    """Run a named migration exactly once per database.

    Tracks applied migrations in schema_meta so idempotent repairs
    do not run on every startup.
    """
    already_applied = await conn.fetchval(
        "SELECT 1 FROM schema_meta WHERE key = $1",
        f"migration_{name}",
    )
    if already_applied:
        return

    await callback(conn)

    await conn.execute(
        """
        INSERT INTO schema_meta (key, value, updated_at)
        VALUES ($1, 'applied', NOW())
        ON CONFLICT (key) DO UPDATE SET value = 'applied', updated_at = NOW()
    """,
        f"migration_{name}",
    )


async def _migrate_collaboration_schema(conn: asyncpg.Connection) -> None:
    """Idempotent migration for collaboration features.

    Adds columns/tables introduced for email invites, comment permissions,
    password-protected shares, @mentions, and notifications.
    """
    from ...logging_config import get_logger

    logger = get_logger(__name__)
    changes = 0

    # workspace_share.can_comment
    has_col = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workspace_share' AND column_name = 'can_comment')"
    )
    if not has_col:
        await conn.execute("ALTER TABLE workspace_share ADD COLUMN can_comment BOOLEAN DEFAULT FALSE")
        changes += 1

    # node_share.can_comment
    has_col = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'node_share' AND column_name = 'can_comment')"
    )
    if not has_col:
        await conn.execute("ALTER TABLE node_share ADD COLUMN can_comment BOOLEAN DEFAULT FALSE")
        changes += 1

    # node_public_share.password_hash
    has_col = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'node_public_share' AND column_name = 'password_hash')"
    )
    if not has_col:
        await conn.execute("ALTER TABLE node_public_share ADD COLUMN password_hash TEXT")
        changes += 1

    # pending_invite table
    has_table = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pending_invite')"
    )
    if not has_table:
        await conn.execute("""
            CREATE TABLE pending_invite (
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
            )
        """)
        await conn.execute("CREATE INDEX idx_pending_invite_email ON pending_invite(email)")
        await conn.execute("CREATE INDEX idx_pending_invite_uuid ON pending_invite(uuid)")
        changes += 1

    # notification table
    has_table = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'notification')"
    )
    if not has_table:
        await conn.execute("""
            CREATE TABLE notification (
                id SERIAL PRIMARY KEY,
                uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
                user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
                type VARCHAR(50) NOT NULL,
                actor_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
                node_uuid UUID,
                message TEXT,
                is_read BOOLEAN DEFAULT FALSE,
                create_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute(
            "CREATE INDEX idx_notification_user_unread ON notification(user_id, is_read) WHERE is_read = FALSE"
        )
        await conn.execute("CREATE INDEX idx_notification_user_date ON notification(user_id, create_date DESC)")
        changes += 1

    # One-way migration for legacy integer notification.node_id column.
    notification_node_id_exists = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'notification' AND column_name = 'node_id')"
    )
    if notification_node_id_exists:
        notification_node_uuid_exists = await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'notification' AND column_name = 'node_uuid')"
        )
        if not notification_node_uuid_exists:
            await conn.execute("ALTER TABLE notification ADD COLUMN node_uuid UUID")
        await conn.execute("""
            UPDATE notification ntf
            SET node_uuid = n.uuid
            FROM node n
            WHERE n.id = ntf.node_id
        """)
        await conn.execute("ALTER TABLE notification DROP COLUMN node_id CASCADE")
        logger.info("Migrated notification.node_id to node_uuid")

    if changes:
        logger.info(f"Collaboration schema migration applied ({changes} change sets)")


async def create_workspace_for_user(conn: asyncpg.Connection, user_id: int, name: str = "Default") -> int:
    """Create a new workspace for a user and seed it through the relay.

    Args:
        conn: Database connection
        user_id: The user ID (owner of the workspace)
        name: Name for the new workspace (defaults to "Default")

    Returns:
        The workspace ID
    """
    now = datetime.now(UTC)

    # Create workspace
    row = await conn.fetchrow(
        """
        INSERT INTO workspace (name, create_uid, write_uid, create_date, write_date)
        VALUES ($1, $2, $2, $3, $3)
        RETURNING id
    """,
        name,
        user_id,
        now,
    )
    if row is None:
        raise RuntimeError("Failed to create workspace")
    workspace_id = row["id"]

    # Seed the canonical operation-log state for the local-first frontend.
    ws_row = await conn.fetchrow("SELECT uuid::text as uuid FROM workspace WHERE id = $1", workspace_id)
    user_row = await conn.fetchrow('SELECT uuid::text as uuid, name, email FROM "user" WHERE id = $1', user_id)
    if ws_row and user_row:
        from app.core.seed import seed_workspace_relay

        await seed_workspace_relay(
            ws_row["uuid"],
            actor_id=user_row["uuid"],
            user_display_name=user_row["name"] or user_row["email"],
        )

    return workspace_id


async def get_or_create_user_workspace(
    conn: asyncpg.Connection,
    user_id: int,
    workspace_uuid: str | None = None,
) -> int:
    """Resolve the user's workspace.

    If workspace_uuid is provided, resolves that specific workspace.
    Otherwise falls back to the user's first owned/shared workspace.

    Checks for:
    1. Specific workspace by UUID (if provided)
    2. Workspaces owned by the user (create_uid)
    3. Workspaces shared with the user (workspace_share)

    Raises:
        ValueError: If no workspace is found for the user.

    Args:
        conn: Database connection
        user_id: The user ID
        workspace_uuid: Optional workspace UUID to resolve

    Returns:
        The workspace ID
    """
    # If a specific workspace UUID is requested, resolve it first
    if workspace_uuid:
        row = await conn.fetchrow(
            """
            SELECT g.id FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.uuid::text = $1 AND g.active = TRUE
              AND (g.create_uid = $2 OR gs.user_id = $2)
        """,
            workspace_uuid,
            user_id,
        )
        if row:
            return row["id"]

    # Check for existing workspace owned by user
    row = await conn.fetchrow(
        """
        SELECT id FROM workspace
        WHERE create_uid = $1 AND active = TRUE
        ORDER BY create_date ASC
        LIMIT 1
    """,
        user_id,
    )

    if row:
        return row["id"]

    # Check for workspaces shared with user
    row = await conn.fetchrow(
        """
        SELECT g.id FROM workspace g
        JOIN workspace_share gs ON g.id = gs.workspace_id
        WHERE gs.user_id = $1 AND gs.active = TRUE AND gs.can_read = TRUE AND g.active = TRUE
        ORDER BY g.create_date ASC
        LIMIT 1
    """,
        user_id,
    )

    if row:
        return row["id"]

    raise ValueError(f"No workspace found for user {user_id}")


async def _seed_system_settings(conn: asyncpg.Connection) -> None:
    """Seed default system settings if they don't exist."""
    defaults = {
        "cleanup_interval_seconds": 86400,
        "cleanup_workspace_max_age_days": 30,
        "cleanup_user_max_age_days": 30,
    }
    for key, value in defaults.items():
        await conn.execute(
            """
            INSERT INTO setting_system (key, value, create_date, write_date)
            VALUES ($1, $2::jsonb, NOW(), NOW())
            ON CONFLICT (key) DO NOTHING
            """,
            key,
            value,
        )


async def _add_user_device_token(conn: asyncpg.Connection) -> None:
    """Add the user_device_token table for push notification support."""
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    has_table = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_device_token')"
    )
    if not has_table:
        await conn.execute("""
            CREATE TABLE user_device_token (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
                token TEXT NOT NULL,
                platform VARCHAR(20) NOT NULL DEFAULT 'unknown',
                active BOOLEAN DEFAULT TRUE,
                create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(user_id, token)
            )
        """)
        await conn.execute("CREATE INDEX idx_user_device_token_user_id ON user_device_token(user_id)")
        await conn.execute("CREATE INDEX idx_user_device_token_token ON user_device_token(token)")
        logger.info("Created user_device_token table")


async def _add_uuid_columns_to_remaining_tables(conn: asyncpg.Connection) -> None:
    """Add uuid columns to tables that were created before the universal UUID migration."""
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    tables = [
        "notification",
        "workspace_share",
    ]

    for table in tables:
        has_uuid = await conn.fetchval(
            """
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = $1 AND column_name = 'uuid'
            )
            """,
            table,
        )
        if has_uuid:
            continue

        await conn.execute(
            f"""
            ALTER TABLE {table}
            ADD COLUMN uuid UUID UNIQUE DEFAULT uuid_generate_v4()
            """
        )
        await conn.execute(
            f"""
            UPDATE {table}
            SET uuid = uuid_generate_v4()
            WHERE uuid IS NULL
            """
        )
        await conn.execute(
            f"""
            ALTER TABLE {table}
            ALTER COLUMN uuid SET NOT NULL
            """
        )
        logger.info(f"Added uuid column to {table}")


async def _add_sync_protocol_version(conn: asyncpg.Connection) -> None:
    """Add sync_protocol_version column to workspace table."""
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    has_column = await conn.fetchval(
        """
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'workspace' AND column_name = 'sync_protocol_version'
        )
        """
    )
    if not has_column:
        await conn.execute("""
            ALTER TABLE workspace
            ADD COLUMN sync_protocol_version VARCHAR(10) NOT NULL DEFAULT 'v2',
            ADD CONSTRAINT chk_workspace_sync_protocol_version
                CHECK (sync_protocol_version IN ('v1', 'v2'))
        """)
        logger.info("Added sync_protocol_version column to workspace")


async def _set_sync_protocol_version_v2_default(conn: asyncpg.Connection) -> None:
    """Move all existing workspaces to v2 and make v2 the column default."""
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    await conn.execute("""
        ALTER TABLE workspace
        ALTER COLUMN sync_protocol_version SET DEFAULT 'v2'
    """)
    updated = await conn.execute("""
        UPDATE workspace
        SET sync_protocol_version = 'v2'
        WHERE sync_protocol_version = 'v1'
    """)
    logger.info("Migrated all workspaces to sync protocol v2: %s", updated)


async def _normalize_settings_jsonb(conn: asyncpg.Connection) -> None:
    """Normalize string-encoded JSONB settings to native JSONB values."""
    from app.db.migrations.normalize_settings_jsonb import run

    await run(conn)


async def _add_totp_2fa(conn: asyncpg.Connection) -> None:
    """Add TOTP two-factor authentication columns and the backup-codes table.

    Idempotent migration: adds totp_secret / totp_enabled / totp_enabled_at to
    the "user" table and creates the user_backup_code table plus its index.
    """
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    # Add TOTP columns to the "user" table if missing.
    for column, ddl in (
        ("totp_secret", 'ALTER TABLE "user" ADD COLUMN totp_secret TEXT'),
        (
            "totp_enabled",
            'ALTER TABLE "user" ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE',
        ),
        ("totp_enabled_at", 'ALTER TABLE "user" ADD COLUMN totp_enabled_at TIMESTAMPTZ'),
    ):
        col_exists = await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user' AND column_name = $1)",
            column,
        )
        if not col_exists:
            await conn.execute(ddl)
            logger.info(f"Added {column} column to user table")

    # Create the backup-codes table if missing.
    table_exists = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_backup_code')"
    )
    if not table_exists:
        await conn.execute(
            """
            CREATE TABLE user_backup_code (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
                code_hash TEXT NOT NULL,
                used_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        logger.info("Created user_backup_code table")

    # Ensure the lookup index exists.
    idx_exists = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_user_backup_code_user')"
    )
    if not idx_exists:
        await conn.execute("CREATE INDEX idx_user_backup_code_user ON user_backup_code(user_id)")
        logger.info("Created idx_user_backup_code_user index")
