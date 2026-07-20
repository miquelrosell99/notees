"""Database initialization and seeding functions for Notees.

This module contains functions for initializing the database schema
and seeding workspaces with system data.

SCHEMA VERSION: 4 - Asset subsystem aligned with M6.
"""

from __future__ import annotations

import contextlib
import hashlib
import shutil
from datetime import UTC, datetime
from pathlib import Path

import asyncpg

from ...domain.entities import generate_uuid
from ...domain.stringify_ast import ParseMode, parse_ast, serialize_ast
from ..connection import setup_jsonb_codec
from .constants import (
    DEFAULT_PAGES,
    SCHEMA_VERSION,
    SYSTEM_CLASS_ICONS,
    SYSTEM_CLASS_UUIDS,
    SYSTEM_CLASSES,
    SYSTEM_PAGE_UUIDS,
    SYSTEM_PROPERTY_UUIDS,
    TASK_PRIORITY_OPTIONS,
    TASK_RECURRENCE_OPTIONS,
    TASK_STATUS_OPTIONS,
)
from .sql import SCHEMA_SQL


async def init_database(conn: asyncpg.Connection) -> None:
    # Ensure JSONB values are read/written as native Python objects on this
    # connection as well as on pooled connections.
    await setup_jsonb_codec(conn)

    """Initialize the database with schema.

    This creates all tables, indexes, and triggers.
    Call this during application startup.
    """
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

    # Clean up legacy node_path closure table artifacts if they still exist
    # from a previous schema version. The closure table has been replaced by
    # recursive CTEs on the adjacency list (parent_id).
    node_path_exists = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'node_path')"
    )
    if node_path_exists:
        from app.logging_config import get_logger

        logger = get_logger(__name__)
        logger.info("Dropping legacy node_path closure table and triggers")
        await conn.execute("DROP TRIGGER IF EXISTS node_path_after_insert ON node")
        await conn.execute("DROP TRIGGER IF EXISTS node_path_after_update ON node")
        await conn.execute("DROP TRIGGER IF EXISTS node_path_before_delete ON node")
        await conn.execute("DROP FUNCTION IF EXISTS node_path_insert()")
        await conn.execute("DROP FUNCTION IF EXISTS node_path_update()")
        await conn.execute("DROP FUNCTION IF EXISTS node_path_delete()")
        await conn.execute("DROP FUNCTION IF EXISTS rebuild_node_path()")
        await conn.execute("DROP TABLE IF EXISTS node_path CASCADE")

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
    await _run_migration("repair_page_ids", conn, _repair_page_ids)
    from app.db.migrations.ensure_task_recurrence_property import run as _run_ensure_task_recurrence_property

    await _run_migration("ensure_task_recurrence_property", conn, _run_ensure_task_recurrence_property)
    await _run_migration("ensure_inbox_system_uuid", conn, _ensure_inbox_system_uuid)
    await _run_migration("migrate_visibility_to_is_private", conn, _migrate_visibility_to_is_private)
    await _run_migration("migrate_mdi_prefix_icons", conn, _migrate_mdi_prefix_icons)
    await _run_migration("migrate_non_system_task_statuses", conn, _migrate_non_system_task_statuses)
    await _run_migration("backfill_is_task_flags", conn, _backfill_is_task_flags)
    await _run_migration("backfill_is_table_flags", conn, _backfill_is_table_flags)
    await _run_migration("migrate_collaboration_schema", conn, _migrate_collaboration_schema)
    await _run_migration("cleanup_self_referencing_aliases", conn, _cleanup_self_referencing_aliases)
    await _run_migration("seed_system_settings", conn, _seed_system_settings)
    await _run_migration("renumber_sequences", conn, _renumber_sequences)
    from app.db.migrations.convert_raw_uuid_to_broken_link import run as _run_convert_raw_uuid

    await _run_migration("convert_raw_uuid_to_broken_link", conn, _run_convert_raw_uuid)
    from app.db.migrations.consolidate_class_path import run as _run_consolidate_class_path

    await _run_migration("consolidate_class_path", conn, _run_consolidate_class_path)
    from app.db.migrations.normalize_inline_class_links import run as _run_normalize_inline_class_links

    await _run_migration("normalize_inline_class_links", conn, _run_normalize_inline_class_links)
    from app.db.migrations.add_node_mention import run as _run_add_node_mention

    await _run_migration("add_node_mention", conn, _run_add_node_mention)
    await _run_migration("remove_tags_system_property", conn, _remove_tags_system_property)
    await _run_migration("materialize_search_text", conn, _materialize_search_text)
    from app.db.migrations.migrate_task_recurrence_to_table import run as _run_migrate_task_recurrence

    await _run_migration("migrate_task_recurrence_to_table", conn, _run_migrate_task_recurrence)
    from app.db.migrations.normalize_settings_jsonb import run as _run_normalize_settings_jsonb

    await _run_migration("normalize_settings_jsonb", conn, _run_normalize_settings_jsonb)
    await _run_migration("add_user_device_token", conn, _add_user_device_token)
    await _run_migration("add_uuid_columns_to_remaining_tables", conn, _add_uuid_columns_to_remaining_tables)
    await _run_migration("add_node_revision", conn, _add_node_revision)
    await _run_migration("add_sync_protocol_version", conn, _add_sync_protocol_version)
    await _run_migration("set_sync_protocol_version_v2_default", conn, _set_sync_protocol_version_v2_default)
    await _run_migration("remove_collapsed_column", conn, _remove_collapsed_column)
    await _run_migration("migrate_assets_m6", conn, _migrate_assets_m6)
    await _run_migration("add_totp_2fa", conn, _add_totp_2fa)


def _extension_to_mime_type(extension: str) -> str:
    """Map a file extension to a MIME type for migrated assets."""
    mapping = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".opus": "audio/opus",
        ".webm": "audio/webm",
        ".pdf": "application/pdf",
    }
    return mapping.get(extension.lower(), "application/octet-stream")


async def _migrate_assets_m6(conn: asyncpg.Connection) -> None:
    """Align the asset subsystem with the M6 specification.

    Idempotent one-way migration that:
      1. Ensures the new ``asset`` table exists with the target columns.
      2. Imports any legacy per-asset UUID folders into ``asset``.
      3. Migrates data from the old ``asset_file`` table into ``asset``,
         moves files to the new layout, and removes ``asset_file``.
      4. Renames ``node.asset_file_id`` to ``node.asset_id``.
      5. Points the foreign key at ``asset(id)``.
    """
    from app.utils.paths import get_workspace_assets_dir

    # ------------------------------------------------------------------
    # 1. Ensure the target asset table exists with the M6 columns.
    # ------------------------------------------------------------------
    asset_exists = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'asset')"
    )
    if not asset_exists:
        await conn.execute(
            """
            CREATE TABLE asset (
                id SERIAL PRIMARY KEY,
                uuid UUID NOT NULL DEFAULT uuid_generate_v4(),
                workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
                hash VARCHAR(64) NOT NULL,
                size INTEGER NOT NULL,
                mime_type VARCHAR(255),
                original_name TEXT,
                refs_count INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (workspace_id, hash)
            )
            """
        )

    # Add any missing M6 columns if the table was created by an earlier schema.
    for column, ddl in (
        ("size", "ALTER TABLE asset ADD COLUMN size INTEGER NOT NULL DEFAULT 0"),
        ("mime_type", "ALTER TABLE asset ADD COLUMN mime_type VARCHAR(255)"),
        ("original_name", "ALTER TABLE asset ADD COLUMN original_name TEXT"),
        ("refs_count", "ALTER TABLE asset ADD COLUMN refs_count INTEGER NOT NULL DEFAULT 1"),
        ("created_at", "ALTER TABLE asset ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"),
    ):
        col_exists = await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'asset' AND column_name = $1)",
            column,
        )
        if not col_exists:
            await conn.execute(ddl)

    # Drop columns that are no longer part of the M6 schema.
    for column in ("extension", "storage_path", "size_bytes", "ref_count", "create_date"):
        col_exists = await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'asset' AND column_name = $1)",
            column,
        )
        if col_exists:
            await conn.execute(f"ALTER TABLE asset DROP COLUMN {column}")

    # ------------------------------------------------------------------
    # 2. Import legacy per-asset UUID folders (pre-content-addressed).
    # ------------------------------------------------------------------
    node_fk_col = "asset_id"
    has_old_fk = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'node' AND column_name = 'asset_file_id')"
    )
    has_new_fk = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'node' AND column_name = 'asset_id')"
    )
    if has_old_fk and not has_new_fk:
        node_fk_col = "asset_file_id"

    rows = await conn.fetch(
        f"""
        SELECT n.id, n.uuid, n.workspace_id, w.uuid::text AS workspace_uuid
        FROM node n
        JOIN workspace w ON w.id = n.workspace_id
        WHERE n.is_asset = TRUE AND n.{node_fk_col} IS NULL AND n.active = TRUE
        """
    )
    hash_to_asset_id: dict[tuple[int, str], int] = {}
    for row in rows:
        assets_dir = get_workspace_assets_dir(row["workspace_uuid"])
        asset_folder = assets_dir / str(row["uuid"])
        if not asset_folder.exists():
            continue

        source_files = [
            f for f in asset_folder.iterdir() if f.is_file() and f.stem == "main" and f.name != "thumbnail.webp"
        ]
        if len(source_files) != 1:
            continue

        source_path = source_files[0]
        file_bytes = source_path.read_bytes()
        file_hash = hashlib.sha256(file_bytes).hexdigest()
        extension = source_path.suffix.lower()
        size = len(file_bytes)
        mime_type = _extension_to_mime_type(extension)

        key = (row["workspace_id"], file_hash)
        if key in hash_to_asset_id:
            asset_id = hash_to_asset_id[key]
            await conn.execute(
                "UPDATE asset SET refs_count = refs_count + 1 WHERE id = $1",
                asset_id,
            )
        else:
            target_path = assets_dir / file_hash[:4] / f"{file_hash}{extension}"
            target_path.parent.mkdir(parents=True, exist_ok=True)
            if not target_path.exists():
                shutil.move(str(source_path), str(target_path))
            else:
                source_path.unlink(missing_ok=True)

            existing = await conn.fetchrow(
                "SELECT id FROM asset WHERE workspace_id = $1 AND hash = $2",
                row["workspace_id"],
                file_hash,
            )
            if existing:
                asset_id = existing["id"]
                await conn.execute(
                    "UPDATE asset SET refs_count = refs_count + 1 WHERE id = $1",
                    asset_id,
                )
            else:
                asset_id = await conn.fetchval(
                    """
                    INSERT INTO asset (workspace_id, hash, size, mime_type, original_name, refs_count, created_at)
                    VALUES ($1, $2, $3, $4, NULL, 1, NOW())
                    RETURNING id
                    """,
                    row["workspace_id"],
                    file_hash,
                    size,
                    mime_type,
                )
            if asset_id is not None:
                hash_to_asset_id[key] = asset_id

        if asset_id is not None:
            await conn.execute(
                f"UPDATE node SET {node_fk_col} = $1 WHERE id = $2",
                asset_id,
                row["id"],
            )

    # ------------------------------------------------------------------
    # 3. Migrate the old asset_file table into asset.
    # ------------------------------------------------------------------
    old_table_exists = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'asset_file')"
    )
    if old_table_exists:
        # Drop the old foreign key before re-pointing node references.
        await conn.execute("ALTER TABLE node DROP CONSTRAINT IF EXISTS fk_node_asset_file")

        old_rows = await conn.fetch(
            "SELECT id, workspace_id, hash, size_bytes, extension, ref_count, storage_path FROM asset_file"
        )
        old_id_to_new_id: dict[int, int] = {}
        for old_row in old_rows:
            workspace_id = old_row["workspace_id"]
            file_hash = old_row["hash"]
            extension = (old_row["extension"] or "").lower()
            if not extension.startswith("."):
                extension = f".{extension}" if extension else ""
            mime_type = _extension_to_mime_type(extension)
            size = old_row["size_bytes"]
            ref_count = old_row["ref_count"]

            # Move file to the new M6 layout.
            assets_dir = None
            workspace_row = await conn.fetchrow(
                "SELECT uuid::text AS workspace_uuid FROM workspace WHERE id = $1",
                workspace_id,
            )
            if workspace_row:
                assets_dir = get_workspace_assets_dir(workspace_row["workspace_uuid"])
                old_path = Path(old_row["storage_path"]) if old_row["storage_path"] else None
                if old_path and not old_path.exists() and extension:
                    old_path = assets_dir / "files" / file_hash[:2] / file_hash[2:4] / f"{file_hash}{extension}"
                if old_path and old_path.exists():
                    target_path = assets_dir / file_hash[:4] / f"{file_hash}{extension}"
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    if target_path.exists():
                        old_path.unlink(missing_ok=True)
                    else:
                        shutil.move(str(old_path), str(target_path))
                    for parent in (old_path.parent, old_path.parent.parent):
                        with contextlib.suppress(OSError):
                            parent.rmdir()

            existing = await conn.fetchrow(
                "SELECT id, refs_count FROM asset WHERE workspace_id = $1 AND hash = $2",
                workspace_id,
                file_hash,
            )
            if existing:
                asset_id = existing["id"]
                new_refs = existing["refs_count"] + ref_count
                await conn.execute(
                    "UPDATE asset SET refs_count = $1 WHERE id = $2",
                    new_refs,
                    asset_id,
                )
            else:
                create_at = old_row.get("create_date") or datetime.now(UTC)
                asset_id = await conn.fetchval(
                    """
                    INSERT INTO asset (workspace_id, hash, size, mime_type, original_name, refs_count, created_at)
                    VALUES ($1, $2, $3, $4, NULL, $5, $6)
                    RETURNING id
                    """,
                    workspace_id,
                    file_hash,
                    size,
                    mime_type,
                    ref_count,
                    create_at,
                )
            old_id_to_new_id[old_row["id"]] = asset_id

        # Point node references to the new asset ids.
        for old_id, new_id in old_id_to_new_id.items():
            await conn.execute(
                f"UPDATE node SET {node_fk_col} = $1 WHERE {node_fk_col} = $2",
                new_id,
                old_id,
            )

        await conn.execute("DROP TABLE asset_file CASCADE")

    # ------------------------------------------------------------------
    # 4. Ensure node uses the asset_id column.
    # ------------------------------------------------------------------
    if has_old_fk and not has_new_fk:
        await conn.execute("ALTER TABLE node RENAME COLUMN asset_file_id TO asset_id")
    elif not has_new_fk:
        await conn.execute("ALTER TABLE node ADD COLUMN asset_id INTEGER")

    # ------------------------------------------------------------------
    # 5. Ensure the foreign key references asset(id).
    # ------------------------------------------------------------------
    fk_exists = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_name = 'node' AND constraint_name = 'fk_node_asset')"
    )
    if not fk_exists:
        await conn.execute("ALTER TABLE node DROP CONSTRAINT IF EXISTS fk_node_asset_file")
        await conn.execute(
            """
            ALTER TABLE node
            ADD CONSTRAINT fk_node_asset
            FOREIGN KEY (asset_id) REFERENCES asset(id) ON DELETE SET NULL
            """
        )

    # ------------------------------------------------------------------
    # 6. Ensure indexes exist.
    # ------------------------------------------------------------------
    idx_exists = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_asset_workspace_hash')"
    )
    if not idx_exists:
        await conn.execute("CREATE INDEX idx_asset_workspace_hash ON asset(workspace_id, hash)")


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


async def _repair_page_ids(conn: asyncpg.Connection) -> None:
    """Fix blocks that have NULL page_id but have a page ancestor.

    Uses a recursive CTE on the adjacency list (parent_id) to find the
    nearest page ancestor for each block and sets page_id accordingly.
    Only updates rows that actually need fixing, so this is fast when
    the data is already correct.

    Also clears page_id on pages that should never have it set.
    """
    # Clear page_id on pages - pages should never have page_id
    clear_result = await conn.execute("""
        UPDATE node
        SET page_id = NULL
        WHERE is_page = TRUE AND page_id IS NOT NULL AND active = TRUE
    """)
    clear_count = int(clear_result.split()[-1]) if clear_result else 0
    if clear_count > 0:
        from ...logging_config import get_logger

        logger = get_logger(__name__)
        logger.info(f"Cleared erroneous page_id from {clear_count} pages")

    result = await conn.execute("""
        WITH RECURSIVE page_ancestors AS (
            -- Start from all non-page nodes with NULL page_id
            SELECT id, parent_id, is_page, id AS start_id, 0 AS depth
            FROM node
            WHERE is_page = FALSE
              AND active = TRUE
              AND page_id IS NULL
            UNION ALL
            -- Walk up the parent chain
            SELECT n.id, n.parent_id, n.is_page, pa.start_id, pa.depth + 1
            FROM node n
            INNER JOIN page_ancestors pa ON n.id = pa.parent_id
            WHERE pa.depth < 100  -- safety limit to prevent infinite loops
        )
        UPDATE node n
        SET page_id = pa.id
        FROM (
            SELECT DISTINCT ON (start_id) start_id, id
            FROM page_ancestors
            WHERE is_page = TRUE
            ORDER BY start_id, depth ASC
        ) pa
        WHERE n.id = pa.start_id
          AND n.is_page = FALSE
          AND n.active = TRUE
          AND n.page_id IS NULL
    """)
    # asyncpg returns "UPDATE N" where N is the count
    count = int(result.split()[-1]) if result else 0
    if count > 0:
        from ...logging_config import get_logger

        logger = get_logger(__name__)
        logger.info(f"Repaired page_id for {count} blocks")


async def _cleanup_self_referencing_aliases(conn: asyncpg.Connection) -> None:
    """Fix any nodes where aliased_id points to the node itself.

    Self-referencing aliases break the alias UI (remove fails with
    'Alias relationship not found') and can cause infinite loops in
    alias resolution.  This runs at every startup so bad data is
    repaired automatically even if it slips past validation.
    """
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    result = await conn.execute("UPDATE node SET aliased_id = NULL WHERE aliased_id = id")
    count = int(result.split()[-1]) if result else 0
    if count > 0:
        logger.warning(f"Cleaned up {count} self-referencing alias(es)")


async def _ensure_inbox_system_uuid(conn: asyncpg.Connection) -> None:
    """Ensure all workspaces have an Inbox page with the fixed system UUID.

    Idempotent migration for existing databases that created Inbox pages
    with random UUIDs before the fixed UUID was introduced.
    """
    from ...logging_config import get_logger

    logger = get_logger(__name__)
    inbox_uuid = SYSTEM_PAGE_UUIDS.get("inbox")
    if not inbox_uuid:
        return

    pt_expr = """(CASE
        WHEN n.name IS NOT NULL AND n.name LIKE '[%' THEN
            COALESCE((SELECT string_agg(t #>> '{}', '') FROM jsonb_path_query(n.name::jsonb, '$.**.text') AS t), '')
        ELSE COALESCE(n.name, '')
    END)"""

    rows = await conn.fetch(
        f"""
        SELECT n.id, n.uuid::text AS old_uuid, n.workspace_id
        FROM node n
        WHERE n.active = TRUE AND n.is_deleted = FALSE
          AND LOWER({pt_expr}) = LOWER('Inbox')
          AND n.uuid::text != $1
        """,
        inbox_uuid,
    )

    for row in rows:
        old_uuid = row["old_uuid"]
        ws_id = row["workspace_id"]
        node_id = row["id"]

        # Update the Inbox page to the fixed UUID
        await conn.execute(
            "UPDATE node SET uuid = $1 WHERE id = $2",
            inbox_uuid,
            node_id,
        )

        # Update any AST content in the workspace that references the old UUID
        await conn.execute(
            """
            UPDATE node
            SET name = REPLACE(REPLACE(name, $1, $2), $3, $4)
            WHERE workspace_id = $5
              AND name LIKE '%' || $6 || '%'
            """,
            f'"link_id":"{old_uuid}:',
            f'"link_id":"{inbox_uuid}:',
            f'"link_id":"{old_uuid}"',
            f'"link_id":"{inbox_uuid}"',
            ws_id,
            old_uuid,
        )

        logger.info(f"Migrated Inbox UUID in workspace {ws_id}: {old_uuid} -> {inbox_uuid}")

    # Create Inbox for workspaces that don't have one at all (old workspaces
    # pre-dating the Inbox default page, or where it was hard-deleted).
    missing_ws_rows = await conn.fetch(
        """
        SELECT w.id AS workspace_id, w.create_uid
        FROM workspace w
        WHERE w.active = TRUE
          AND NOT EXISTS (
              SELECT 1 FROM node n
              WHERE n.workspace_id = w.id
                AND n.uuid::text = $1
                AND n.active = TRUE
                AND (n.is_deleted = FALSE OR n.is_deleted IS NULL)
          )
        """,
        inbox_uuid,
    )

    for row in missing_ws_rows:
        ws_id = row["workspace_id"]
        user_id = row["create_uid"]
        if user_id is None:
            logger.warning(f"Skipping Inbox creation for workspace {ws_id}: no create_uid")
            continue

        page_class_row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2 AND active = TRUE",
            SYSTEM_CLASS_UUIDS["page"],
            ws_id,
        )
        if not page_class_row:
            logger.warning(f"Skipping Inbox creation for workspace {ws_id}: page class not found")
            continue

        page_class_id = page_class_row["id"]
        now = datetime.now(UTC)

        inbox_row = await conn.fetchrow(
            """
            INSERT INTO node (uuid, workspace_id, name, is_page, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, $3, TRUE, $4, $4, $5, $5)
            ON CONFLICT (workspace_id, uuid) DO NOTHING
            RETURNING id
            """,
            inbox_uuid,
            ws_id,
            serialize_ast(parse_ast("Inbox", ParseMode.PLAIN)),
            now,
            user_id,
        )
        if inbox_row:
            await conn.execute(
                "UPDATE node SET class_ids = $1 WHERE id = $2",
                [page_class_id],
                inbox_row["id"],
            )
            logger.info(f"Created Inbox for workspace {ws_id}")


async def _migrate_visibility_to_is_private(conn: asyncpg.Connection) -> None:
    """Migrate from visibility VARCHAR column to is_private BOOLEAN.

    Idempotent one-way migration for existing databases.
    """
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    # Check if old visibility column still exists
    old_col_exists = await conn.fetchval(
        """
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'node' AND column_name = 'visibility'
        )
        """
    )

    # Check if new is_private column exists
    new_col_exists = await conn.fetchval(
        """
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'node' AND column_name = 'is_private'
        )
        """
    )

    if not new_col_exists:
        await conn.execute("ALTER TABLE node ADD COLUMN is_private BOOLEAN NOT NULL DEFAULT FALSE")
        logger.info("Added is_private column to node table")

    if old_col_exists and new_col_exists:
        # Migrate data: private -> TRUE, everything else -> FALSE
        await conn.execute("UPDATE node SET is_private = TRUE WHERE visibility = 'private'")
        logger.info("Migrated visibility data to is_private")

        # Drop old column (cascade to index)
        await conn.execute("ALTER TABLE node DROP COLUMN visibility CASCADE")
        logger.info("Dropped old visibility column")

    # Ensure new index exists
    idx_exists = await conn.fetchval(
        """
        SELECT EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE indexname = 'idx_node_is_private'
        )
        """
    )

    if not idx_exists:
        await conn.execute(
            """
            CREATE INDEX idx_node_is_private ON node(workspace_id, is_private)
            WHERE active = TRUE AND is_deleted = FALSE
            """
        )
        logger.info("Created idx_node_is_private index")


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


async def _migrate_non_system_task_statuses(conn: asyncpg.Connection) -> None:
    """Remove non-system task status options and migrate nodes that use them.

    Task statuses are defined in TASK_STATUS_OPTIONS. Any custom selection lines
    added to the Status property that are not in this list are considered
    non-system. Nodes using these statuses are migrated to 'Pending' (or the
    first available system status as fallback).
    """
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    system_names = [opt["name"] for opt in TASK_STATUS_OPTIONS]
    status_uuid = SYSTEM_PROPERTY_UUIDS["task_status"]

    # Find all Status properties across workspaces
    status_props = await conn.fetch(
        "SELECT id, workspace_id FROM property WHERE uuid = $1",
        status_uuid,
    )

    if not status_props:
        return

    total_migrated = 0
    total_removed = 0

    for prop_row in status_props:
        prop_id = prop_row["id"]
        ws_id = prop_row["workspace_id"]

        # Find system status lines for this property
        system_lines = await conn.fetch(
            "SELECT id, name FROM property_selection_line WHERE property_id = $1 AND name = ANY($2)",
            prop_id,
            system_names,
        )

        if not system_lines:
            continue

        # Prefer 'Pending' as fallback, then first available system status
        fallback_id = None
        for line in system_lines:
            if line["name"] == "Pending":
                fallback_id = line["id"]
                break
        if fallback_id is None:
            fallback_id = system_lines[0]["id"]

        # Find non-system status lines for this property
        non_system = await conn.fetch(
            "SELECT id, name FROM property_selection_line WHERE property_id = $1 AND NOT (name = ANY($2))",
            prop_id,
            system_names,
        )

        for line in non_system:
            line_id = line["id"]
            line_name = line["name"]

            # Migrate nodes using this non-system status to the fallback
            result = await conn.execute(
                "UPDATE property_value_selection SET selection_line_id = $1 WHERE selection_line_id = $2",
                fallback_id,
                line_id,
            )
            migrated = int(result.split()[-1]) if result else 0
            total_migrated += migrated

            # Remove the non-system selection line
            await conn.execute(
                "DELETE FROM property_selection_line WHERE id = $1",
                line_id,
            )
            total_removed += 1

            logger.info(
                f"Removed non-system task status '{line_name}' from workspace {ws_id}, "
                f"migrated {migrated} node(s) to fallback status"
            )

    if total_removed > 0:
        logger.info(
            f"Migration complete: removed {total_removed} non-system task status(es), migrated {total_migrated} node(s)"
        )


async def _backfill_is_task_flags(conn: asyncpg.Connection) -> None:
    """Set node.is_task for nodes that already have the task class assigned.

    is_task is kept in sync with class assignments by the node repository, but
    existing databases created before the flag was introduced need a one-time
    backfill from class_ids.
    """
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    task_uuid = SYSTEM_CLASS_UUIDS["task"]
    task_class_rows = await conn.fetch(
        """
        SELECT id, workspace_id FROM node
        WHERE uuid = $1 AND is_class = TRUE AND active = TRUE
    """,
        task_uuid,
    )

    if not task_class_rows:
        return

    total_updated = 0
    for row in task_class_rows:
        task_class_id = row["id"]
        result = await conn.execute(
            """
            UPDATE node
            SET is_task = TRUE
            WHERE workspace_id = $1
              AND is_task = FALSE
              AND active = TRUE
              AND is_deleted = FALSE
              AND $2 = ANY(class_ids)
        """,
            row["workspace_id"],
            task_class_id,
        )
        count = int(result.split()[-1]) if result else 0
        total_updated += count

    if total_updated > 0:
        logger.info(f"Backfilled is_task flag for {total_updated} task node(s)")


async def _backfill_is_table_flags(conn: asyncpg.Connection) -> None:
    """Set node.is_table for nodes that already have the table class assigned.

    is_table is kept in sync with class assignments by the node repository, but
    existing databases created before the flag was introduced need a one-time
    backfill from class_ids.
    """
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    table_uuid = SYSTEM_CLASS_UUIDS["table"]
    table_class_rows = await conn.fetch(
        """
        SELECT id, workspace_id FROM node
        WHERE uuid = $1 AND is_class = TRUE AND active = TRUE
    """,
        table_uuid,
    )

    if not table_class_rows:
        return

    total_updated = 0
    for row in table_class_rows:
        table_class_id = row["id"]
        result = await conn.execute(
            """
            UPDATE node
            SET is_table = TRUE
            WHERE workspace_id = $1
              AND is_table = FALSE
              AND active = TRUE
              AND is_deleted = FALSE
              AND $2 = ANY(class_ids)
        """,
            row["workspace_id"],
            table_class_id,
        )
        count = int(result.split()[-1]) if result else 0
        total_updated += count

    if total_updated > 0:
        logger.info(f"Backfilled is_table flag for {total_updated} table node(s)")


async def _migrate_mdi_prefix_icons(conn: asyncpg.Connection) -> None:
    """Strip the legacy 'mdi:' prefix from property and selection line icons.

    The frontend icon system expects plain kebab-case names (e.g. 'circle-outline').
    Older data was stored with a Logseq-style 'mdi:' prefix (e.g. 'mdi:circle-outline')
    which renders as raw text in components that do not handle the prefix.

    This migration updates both property.icon and property_selection_line.icon,
    including JSON-encoded icon objects that contain an 'icon' key.
    """
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    # plain property icons
    result = await conn.execute(
        """
        UPDATE property
        SET icon = REGEXP_REPLACE(icon, '^mdi:', '')
        WHERE icon LIKE 'mdi:%'
        """
    )
    prop_count = int(result.split()[-1]) if result else 0

    # selection line plain icons
    result = await conn.execute(
        """
        UPDATE property_selection_line
        SET icon = REGEXP_REPLACE(icon, '^mdi:', '')
        WHERE icon LIKE 'mdi:%' AND icon NOT LIKE '{%}'
        """
    )
    line_count = int(result.split()[-1]) if result else 0

    # JSON-encoded selection line icons: {"icon":"mdi:...","color":"..."}
    result = await conn.execute(
        """
        UPDATE property_selection_line
        SET icon = REGEXP_REPLACE(icon, '"icon":"mdi:', '"icon":"', 'g')
        WHERE icon LIKE '%"icon":"mdi:%'
        """
    )
    json_count = int(result.split()[-1]) if result else 0

    total = prop_count + line_count + json_count
    if total > 0:
        logger.info(
            f"Stripped mdi: prefix from {total} icon rows "
            f"({prop_count} properties, {line_count} selection lines, {json_count} JSON icons)"
        )


async def _migrate_collaboration_schema(conn: asyncpg.Connection) -> None:
    """Idempotent migration for collaboration features.

    Adds columns/tables introduced for email invites, comment permissions,
    password-protected shares, @mentions, and notifications.
    """
    from ...logging_config import get_logger

    logger = get_logger(__name__)
    changes = 0

    # user.user_page_node_id
    has_col = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user' AND column_name = 'user_page_node_id')"
    )
    if not has_col:
        await conn.execute(
            'ALTER TABLE "user" ADD COLUMN user_page_node_id INTEGER REFERENCES node(id) ON DELETE SET NULL'
        )
        changes += 1

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
                node_id INTEGER REFERENCES node(id) ON DELETE CASCADE,
                role VARCHAR(20) DEFAULT 'viewer',
                invited_by INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                expires_at TIMESTAMPTZ,
                active BOOLEAN DEFAULT TRUE,
                UNIQUE(email, workspace_id, node_id)
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


async def seed_workspace(conn: asyncpg.Connection, workspace_id: int, user_id: int) -> None:
    """Seed a workspace with system types, properties, and default pages.

    This should be called when creating a new workspace.

    Args:
        conn: Database connection
        workspace_id: The ID of the workspace to seed
        user_id: The user ID for create_uid/write_uid fields
    """
    now = datetime.now(UTC)

    # Helper to get or create node_property assignment
    async def get_or_create_node_property(node_id: int, property_id: int) -> int:
        """Get or create a node_property assignment."""
        row = await conn.fetchrow(
            "SELECT id FROM node_property WHERE node_id = $1 AND property_id = $2", node_id, property_id
        )
        if row:
            return row["id"]
        row = await conn.fetchrow(
            """
            INSERT INTO node_property (uuid, node_id, property_id, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, $3, $4, $4, $5, $5)
            RETURNING id
        """,
            generate_uuid(),
            node_id,
            property_id,
            now,
            user_id,
        )
        if not row:
            raise RuntimeError(f"Failed to create node_property for node {node_id}")
        return row["id"]

    # Create 'class' node (renamed from 'type')
    class_uuid = SYSTEM_CLASS_UUIDS["class"]
    class_icon = SYSTEM_CLASS_ICONS.get("class")
    class_row = await conn.fetchrow(
        """
        INSERT INTO node (uuid, workspace_id, name, icon, is_class, is_page, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, $3, $4, TRUE, TRUE, $5, $5, $6, $6)
        RETURNING id
    """,
        class_uuid,
        workspace_id,
        serialize_ast(parse_ast("class", ParseMode.PLAIN)),
        class_icon,
        now,
        user_id,
    )
    if class_row is None:
        raise RuntimeError("Failed to create 'class' node")
    class_node_id = class_row["id"]

    # Create 'page' class node
    page_uuid = SYSTEM_CLASS_UUIDS["page"]
    page_row = await conn.fetchrow(
        """
        INSERT INTO node (uuid, workspace_id, name, is_class, is_page, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, $3, TRUE, TRUE, $4, $4, $5, $5)
        RETURNING id
    """,
        page_uuid,
        workspace_id,
        serialize_ast(parse_ast("page", ParseMode.PLAIN)),
        now,
        user_id,
    )
    if page_row is None:
        raise RuntimeError("Failed to create 'page' node")
    page_class_id = page_row["id"]

    # Classes are now stored in node.class_ids column (no longer a property)
    # Assign classes to 'class' node using direct UPDATE
    await conn.execute(
        """
        UPDATE node SET class_ids = $1 WHERE id = $2
    """,
        [class_node_id, page_class_id],
        class_node_id,
    )

    # Assign classes to 'page' node using direct UPDATE
    await conn.execute(
        """
        UPDATE node SET class_ids = $1 WHERE id = $2
    """,
        [class_node_id, page_class_id],
        page_class_id,
    )

    # Create other system properties
    show_hier_uuid = SYSTEM_PROPERTY_UUIDS["show_hierarchy"]
    await conn.execute(
        """
        INSERT INTO property (uuid, workspace_id, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'Show hierarchy', 'boolean', FALSE, TRUE, $3, $3, $4, $4)
        ON CONFLICT (workspace_id, uuid) DO NOTHING
    """,
        show_hier_uuid,
        workspace_id,
        now,
        user_id,
    )

    # Create 'Cover' property
    cover_uuid = SYSTEM_PROPERTY_UUIDS["cover"]
    cover_row = await conn.fetchrow(
        """
        INSERT INTO property (uuid, workspace_id, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'Cover', 'image', FALSE, TRUE, $3, $3, $4, $4)
        ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """,
        cover_uuid,
        workspace_id,
        now,
        user_id,
    )
    if cover_row is None:
        raise RuntimeError("Failed to create 'Cover' property")
    cover_property_id = cover_row["id"]

    # Create 'Banner' property
    banner_uuid = SYSTEM_PROPERTY_UUIDS["banner"]
    banner_row = await conn.fetchrow(
        """
        INSERT INTO property (uuid, workspace_id, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'Banner', 'image', FALSE, TRUE, $3, $3, $4, $4)
        ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """,
        banner_uuid,
        workspace_id,
        now,
        user_id,
    )
    if banner_row is None:
        raise RuntimeError("Failed to create 'Banner' property")
    banner_property_id = banner_row["id"]

    # Create 'Description' property (multi text)
    description_uuid = SYSTEM_PROPERTY_UUIDS["description"]
    await conn.execute(
        """
        INSERT INTO property (uuid, workspace_id, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'Description', 'text', TRUE, TRUE, $3, $3, $4, $4)
        ON CONFLICT (workspace_id, uuid) DO NOTHING
    """,
        description_uuid,
        workspace_id,
        now,
        user_id,
    )

    # Note: 'extends' property removed - class inheritance now uses class_extend table directly

    # Create remaining system classes
    asset_type_id = None
    task_class_id = None

    for class_name in SYSTEM_CLASSES:
        if class_name in ("class", "page"):
            continue

        class_uuid = SYSTEM_CLASS_UUIDS.get(class_name, generate_uuid())
        class_icon = SYSTEM_CLASS_ICONS.get(class_name)

        row = await conn.fetchrow(
            """
            INSERT INTO node (uuid, workspace_id, name, icon, is_class, is_page, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, $3, $4, TRUE, TRUE, $5, $5, $6, $6)
            RETURNING id
        """,
            class_uuid,
            workspace_id,
            serialize_ast(parse_ast(class_name, ParseMode.PLAIN)),
            class_icon,
            now,
            user_id,
        )
        if row is None:
            raise RuntimeError(f"Failed to create '{class_name}' class node")
        new_class_id = row["id"]

        if class_name == "asset":
            asset_type_id = new_class_id
        if class_name == "task":
            task_class_id = new_class_id

        # Assign 'class' and 'page' classes using direct UPDATE to class_ids column
        await conn.execute(
            """
            UPDATE node SET class_ids = $1 WHERE id = $2
        """,
            [class_node_id, page_class_id],
            new_class_id,
        )

    # Set class filter for 'Cover' and 'Banner' properties
    if asset_type_id:
        await conn.execute(
            """
            INSERT INTO property_class_filter (property_id, class_node_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
        """,
            cover_property_id,
            asset_type_id,
        )
        await conn.execute(
            """
            INSERT INTO property_class_filter (property_id, class_node_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
        """,
            banner_property_id,
            asset_type_id,
        )

    # Create task class properties (Status, Deadline, Scheduled, Priority)
    if task_class_id:
        # 1. Create 'Status' selection property
        status_row = await conn.fetchrow(
            """
            INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, icon_visibility, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, 'Status', 'list-status', 'selection', FALSE, FALSE, 'after_bullet', $3, $3, $4, $4)
            ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
            RETURNING id
        """,
            SYSTEM_PROPERTY_UUIDS["task_status"],
            workspace_id,
            now,
            user_id,
        )
        if status_row:
            status_property_id = status_row["id"]
            # Create status options
            pending_option_id = None
            for _i, opt in enumerate(TASK_STATUS_OPTIONS):
                opt_row = await conn.fetchrow(
                    """
                    INSERT INTO property_selection_line (property_id, name, icon)
                    VALUES ($1, $2, $3)
                    RETURNING id
                """,
                    status_property_id,
                    opt["name"],
                    opt["icon"],
                )
                if opt_row and opt["name"] == "Pending":
                    pending_option_id = opt_row["id"]

            # Link status property to task class with "Pending" as default
            await conn.execute(
                """
                INSERT INTO class_property (class_node_id, property_id, sequence, default_selection_id)
                VALUES ($1, $2, 0, $3)
                ON CONFLICT (class_node_id, property_id) DO NOTHING
            """,
                task_class_id,
                status_property_id,
                pending_option_id,
            )

            # Task status is required at property level; Pending is the base default.
            # Key on the per-workspace row id: the system property UUID is shared
            # across workspaces, so a uuid-keyed UPDATE would repoint every
            # workspace's default to this workspace's Pending line.
            await conn.execute(
                """
                UPDATE property
                SET required = TRUE, default_selection_id = $1
                WHERE id = $2
            """,
                pending_option_id,
                status_property_id,
            )

        # 2. Create 'Deadline' date property
        deadline_row = await conn.fetchrow(
            """
            INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, 'Deadline', 'calendar-clock', 'date', FALSE, FALSE, $3, $3, $4, $4)
            ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
            RETURNING id
        """,
            SYSTEM_PROPERTY_UUIDS["task_deadline"],
            workspace_id,
            now,
            user_id,
        )
        if deadline_row:
            await conn.execute(
                """
                INSERT INTO class_property (class_node_id, property_id, sequence)
                VALUES ($1, $2, 1)
                ON CONFLICT (class_node_id, property_id) DO NOTHING
            """,
                task_class_id,
                deadline_row["id"],
            )

        # 3. Create 'Scheduled' date property
        scheduled_row = await conn.fetchrow(
            """
            INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, 'Scheduled Date', 'calendar-check', 'date', FALSE, FALSE, $3, $3, $4, $4)
            ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
            RETURNING id
        """,
            SYSTEM_PROPERTY_UUIDS["task_scheduled"],
            workspace_id,
            now,
            user_id,
        )
        if scheduled_row:
            await conn.execute(
                """
                INSERT INTO class_property (class_node_id, property_id, sequence)
                VALUES ($1, $2, 2)
                ON CONFLICT (class_node_id, property_id) DO NOTHING
            """,
                task_class_id,
                scheduled_row["id"],
            )

        # 4. Create 'Priority' selection property
        priority_row = await conn.fetchrow(
            """
            INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, 'Priority', 'flag', 'selection', FALSE, FALSE, $3, $3, $4, $4)
            ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
            RETURNING id
        """,
            SYSTEM_PROPERTY_UUIDS["task_priority"],
            workspace_id,
            now,
            user_id,
        )
        if priority_row:
            priority_property_id = priority_row["id"]
            for _i, opt in enumerate(TASK_PRIORITY_OPTIONS):
                await conn.execute(
                    """
                    INSERT INTO property_selection_line (property_id, name, icon)
                    VALUES ($1, $2, $3)
                """,
                    priority_property_id,
                    opt["name"],
                    opt["icon"],
                )

            # Link priority property to task class (no default)
            await conn.execute(
                """
                INSERT INTO class_property (class_node_id, property_id, sequence)
                VALUES ($1, $2, 3)
                ON CONFLICT (class_node_id, property_id) DO NOTHING
            """,
                task_class_id,
                priority_property_id,
            )

        # 5. Create 'Closed Date' date property
        closed_date_row = await conn.fetchrow(
            """
            INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, 'Closed Date', 'calendar-remove', 'date', FALSE, FALSE, $3, $3, $4, $4)
            ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
            RETURNING id
        """,
            SYSTEM_PROPERTY_UUIDS["task_closed_date"],
            workspace_id,
            now,
            user_id,
        )
        if closed_date_row:
            await conn.execute(
                """
                INSERT INTO class_property (class_node_id, property_id, sequence)
                VALUES ($1, $2, 4)
                ON CONFLICT (class_node_id, property_id) DO NOTHING
            """,
                task_class_id,
                closed_date_row["id"],
            )

        # 6. Create 'Recurrence' selection property
        recurrence_row = await conn.fetchrow(
            """
            INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, 'Recurrence', 'repeat', 'selection', FALSE, FALSE, $3, $3, $4, $4)
            ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
            RETURNING id
        """,
            SYSTEM_PROPERTY_UUIDS["task_recurrence"],
            workspace_id,
            now,
            user_id,
        )
        if recurrence_row:
            recurrence_property_id = recurrence_row["id"]
            for _i, opt in enumerate(TASK_RECURRENCE_OPTIONS):
                await conn.execute(
                    """
                    INSERT INTO property_selection_line (property_id, name, icon)
                    VALUES ($1, $2, $3)
                """,
                    recurrence_property_id,
                    opt["name"],
                    opt["icon"],
                )

            # Link recurrence property to task class (no default)
            await conn.execute(
                """
                INSERT INTO class_property (class_node_id, property_id, sequence)
                VALUES ($1, $2, 5)
                ON CONFLICT (class_node_id, property_id) DO NOTHING
            """,
                task_class_id,
                recurrence_property_id,
            )

    # Create default pages
    for page_name in DEFAULT_PAGES:
        page_uuid = generate_uuid()
        if page_name == "Inbox":
            page_uuid = SYSTEM_PAGE_UUIDS.get("inbox", generate_uuid())
        row = await conn.fetchrow(
            """
            INSERT INTO node (uuid, workspace_id, name, is_page, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, $3, TRUE, $4, $4, $5, $5)
            RETURNING id
        """,
            page_uuid,
            workspace_id,
            serialize_ast(parse_ast(page_name, ParseMode.PLAIN)),
            now,
            user_id,
        )
        if row is None:
            raise RuntimeError(f"Failed to create '{page_name}' page")
        new_page_id = row["id"]

        # Assign 'page' class using direct UPDATE to class_ids column
        await conn.execute(
            """
            UPDATE node SET class_ids = $1 WHERE id = $2
        """,
            [page_class_id],
            new_page_id,
        )

    # Create Scratchpad system page with fixed UUID
    scratchpad_uuid = SYSTEM_PAGE_UUIDS["scratchpad"]
    scratchpad_row = await conn.fetchrow(
        """
        INSERT INTO node (uuid, workspace_id, name, is_page, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, $3, TRUE, $4, $4, $5, $5)
        ON CONFLICT (workspace_id, uuid) DO NOTHING
        RETURNING id
    """,
        scratchpad_uuid,
        workspace_id,
        serialize_ast(parse_ast("Scratchpad", ParseMode.PLAIN)),
        now,
        user_id,
    )
    if scratchpad_row:
        await conn.execute(
            """
            UPDATE node SET class_ids = $1 WHERE id = $2
        """,
            [page_class_id],
            scratchpad_row["id"],
        )


async def create_workspace_for_user(conn: asyncpg.Connection, user_id: int, name: str = "Default") -> int:
    """Create a new workspace for a user and seed it with system data.

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

    # Seed workspace with system data
    await seed_workspace(conn, workspace_id, user_id)

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


async def _renumber_sequences(conn: asyncpg.Connection) -> None:
    """Renumber all node sequences as contiguous floats under each parent."""
    await conn.execute(
        """
        WITH numbered AS (
            SELECT id,
                   ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY sequence, id) - 1 AS new_seq
            FROM node
            WHERE parent_id IS NOT NULL
              AND active = TRUE
              AND is_deleted = FALSE
        )
        UPDATE node
        SET sequence = numbered.new_seq::float
        FROM numbered
        WHERE node.id = numbered.id
          AND node.sequence != numbered.new_seq::float
        """
    )


async def _remove_tags_system_property(conn: asyncpg.Connection) -> None:
    """Remove the legacy 'Tags' system property now that tags live in node.tag_ids."""
    tag_property_uuid = SYSTEM_PROPERTY_UUIDS["tags"]
    rows = await conn.fetch(
        "SELECT id FROM property WHERE uuid = $1",
        tag_property_uuid,
    )
    for row in rows:
        property_id = row["id"]
        # Delete property values tied to this property
        await conn.execute(
            "DELETE FROM property_value_relation WHERE property_id = $1",
            property_id,
        )
        await conn.execute(
            "DELETE FROM property_value_scalar WHERE property_id = $1",
            property_id,
        )
        await conn.execute(
            "DELETE FROM property_value_selection WHERE property_id = $1",
            property_id,
        )
        await conn.execute(
            "DELETE FROM node_property WHERE property_id = $1",
            property_id,
        )
        await conn.execute(
            "DELETE FROM property_class_filter WHERE property_id = $1",
            property_id,
        )
        # Delete the property itself
        await conn.execute(
            "DELETE FROM property WHERE id = $1",
            property_id,
        )


async def _materialize_search_text(conn: asyncpg.Connection) -> None:
    """Add and populate the materialized node.search_text column.

    Existing databases may already have the column from SCHEMA_SQL, but the
    trigger-populated values will be NULL until this migration runs.  We add
    the column idempotently, ensure the helper functions and triggers exist,
    and backfill all existing rows.
    """
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    await conn.execute("ALTER TABLE node ADD COLUMN IF NOT EXISTS search_text TEXT")

    # Recreate functions/triggers idempotently in case an older schema left
    # them in a partial state.
    await conn.execute(
        """
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

        -- Drop legacy BEFORE UPDATE trigger if it exists; we use AFTER UPDATE.
        DROP TRIGGER IF EXISTS node_search_text_update_trigger ON node;
        DROP FUNCTION IF EXISTS node_search_text_update();

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
        """
    )

    result = await conn.execute(
        """
        UPDATE node
        SET search_text = compute_node_search_text(id)
        WHERE search_text IS NULL
          AND active = TRUE
          AND is_deleted = FALSE
        """
    )
    count = int(result.split()[-1]) if result else 0
    if count > 0:
        logger.info(f"Backfilled search_text for {count} existing nodes")


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
        "node_version",
        "node_activity",
        "link_click",
        "notification",
        "workspace_share",
        "undo_log",
        "class_property",
        "class_extend",
        "property_class_filter",
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


async def _add_node_revision(conn: asyncpg.Connection) -> None:
    """Add node_revision table for the v2 sync protocol."""
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    has_table = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'node_revision')"
    )
    if not has_table:
        await conn.execute("""
            CREATE TABLE node_revision (
                node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
                client_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                applied_at TIMESTAMPTZ DEFAULT now(),
                PRIMARY KEY (node_id, client_id)
            )
        """)
        await conn.execute("CREATE INDEX idx_node_revision_node ON node_revision(node_id)")
        logger.info("Created node_revision table")


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


async def _remove_collapsed_column(conn: asyncpg.Connection) -> None:
    """Drop the legacy collapsed column from node and rebuild the affected index."""
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    has_column = await conn.fetchval(
        """
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'node' AND column_name = 'collapsed'
        )
        """
    )
    if not has_column:
        return

    await conn.execute("DROP INDEX IF EXISTS idx_node_page_content")
    await conn.execute("ALTER TABLE node DROP COLUMN collapsed")
    await conn.execute("""
        CREATE INDEX idx_node_page_content ON node(page_id, sequence)
        INCLUDE (id, uuid, icon, color, parent_id, active, class_ids)
        WHERE active = TRUE AND is_deleted = FALSE AND is_comment = FALSE
    """)
    logger.info("Dropped collapsed column and rebuilt idx_node_page_content")


