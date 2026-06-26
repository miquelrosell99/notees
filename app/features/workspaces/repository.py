"""PostgreSQL implementation of WorkspaceRepository."""

from __future__ import annotations

import shutil
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg

from app.db.connection import acquire_connection, get_workspace_dir
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS
from app.features.workspaces.port import WorkspaceIORepository, WorkspaceRepository
from app.logging_config import get_logger

from ...domain.stringify_ast import (
    StringifyMode,
    StringifyOptions,
    parse_ast,
    serialize_ast,
    stringify_ast,
)
from ...utils.import_records import build_import_records

logger = get_logger(__name__)

# Large workspaces (21k+ nodes) blow the 60-second pool command_timeout because
# PostgreSQL's per-row triggers fire for every affected node.
# The notees DB user is the table owner so DISABLE TRIGGER ALL is permitted.
_BULK_DELETE_TIMEOUT = 600  # 10-minute ceiling for bulk workspace deletion


class PostgresWorkspaceRepository(WorkspaceRepository):
    """PostgreSQL adapter for workspace lifecycle, membership, and invite operations."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    # -------------------------------------------------------------------------
    # Lifecycle CRUD (migrated from app.workspace_manager)
    # -------------------------------------------------------------------------

    async def list_workspaces(self, user_id: int) -> list[Any]:
        async with acquire_connection(self._pool) as conn:
            return await conn.fetch(
                """
                SELECT DISTINCT g.uuid, g.name, g.create_date, g.write_date, g.is_shared,
                                g.sync_protocol_version,
                                g.create_uid = $1 as is_owner,
                                gs.can_read as s_can_read,
                                gs.can_write as s_can_write,
                                gs.can_create as s_can_create,
                                gs.can_delete as s_can_delete
                FROM workspace g
                LEFT JOIN workspace_share gs
                    ON g.id = gs.workspace_id
                    AND gs.user_id = $1
                    AND gs.active = TRUE
                WHERE g.create_uid = $1 OR gs.user_id = $1
                ORDER BY g.create_date DESC
                """,
                user_id,
            )

    async def get_by_name_and_owner(self, name: str, owner_id: int) -> Any | None:
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchrow(
                """
                SELECT id, uuid, name, create_date
                FROM workspace
                WHERE create_uid = $1 AND name = $2 AND active = TRUE
                """,
                owner_id,
                name,
            )

    async def create(self, name: str, owner_id: int) -> Any:
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchrow(
                """
                INSERT INTO workspace (name, create_uid, write_uid, is_shared, active)
                VALUES ($1, $2, $2, FALSE, TRUE)
                RETURNING id, uuid, name, create_date
                """,
                name,
                owner_id,
            )

    async def get_by_uuid_for_user(self, workspace_uuid: str, user_id: int) -> Any | None:
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchrow(
                """
                SELECT g.id FROM workspace g
                LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
                WHERE g.uuid::text = $1 AND g.active = TRUE
                  AND (g.create_uid = $2 OR gs.user_id = $2)
                """,
                workspace_uuid,
                user_id,
            )

    async def get_id_by_uuid_and_owner(self, workspace_uuid: str, owner_id: int) -> int | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT id FROM workspace WHERE create_uid = $1 AND uuid::text = $2",
                owner_id,
                workspace_uuid,
            )
            return row["id"] if row else None

    async def rename(self, workspace_id: int, new_name: str, owner_id: int) -> Any | None:
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchrow(
                """
                UPDATE workspace
                SET name = $1, write_date = NOW(), write_uid = $3
                WHERE id = $2
                RETURNING uuid, name, create_date
                """,
                new_name,
                workspace_id,
                owner_id,
            )

    async def delete_cascade(self, workspace_id: int) -> bool:
        async with acquire_connection(self._pool) as conn:
            ws_row = await conn.fetchrow(
                "SELECT id, uuid::text as uuid FROM workspace WHERE id = $1",
                workspace_id,
                timeout=_BULK_DELETE_TIMEOUT,
            )
            if not ws_row:
                return False

            await conn.execute(
                "ALTER TABLE node DISABLE TRIGGER ALL",
                timeout=_BULK_DELETE_TIMEOUT,
            )
            try:
                await conn.execute(
                    """
                    DELETE FROM node_activity
                    WHERE node_id IN (SELECT id FROM node WHERE workspace_id = $1)
                    """,
                    workspace_id,
                    timeout=_BULK_DELETE_TIMEOUT,
                )
                await conn.execute(
                    """
                    DELETE FROM link_click
                    WHERE source_node_id IN (SELECT id FROM node WHERE workspace_id = $1)
                       OR target_node_id IN (SELECT id FROM node WHERE workspace_id = $1)
                    """,
                    workspace_id,
                    timeout=_BULK_DELETE_TIMEOUT,
                )
                await conn.execute(
                    "DELETE FROM node WHERE workspace_id = $1",
                    workspace_id,
                    timeout=_BULK_DELETE_TIMEOUT,
                )
            finally:
                await conn.execute(
                    "ALTER TABLE node ENABLE TRIGGER ALL",
                    timeout=_BULK_DELETE_TIMEOUT,
                )

            await conn.execute(
                "DELETE FROM property WHERE workspace_id = $1",
                workspace_id,
                timeout=_BULK_DELETE_TIMEOUT,
            )
            result = await conn.execute(
                "DELETE FROM workspace WHERE id = $1",
                workspace_id,
                timeout=_BULK_DELETE_TIMEOUT,
            )

            deleted = result.split()[-1] != "0"
            if deleted:
                workspace_dir_path = get_workspace_dir(str(ws_row["uuid"]))
                if workspace_dir_path.exists():
                    try:
                        shutil.rmtree(workspace_dir_path)
                        logger.info(f"Deleted workspace folder: {workspace_dir_path}")
                    except Exception as e:
                        logger.error(
                            f"Failed to delete workspace folder {workspace_dir_path}: {e}",
                            exc_info=True,
                        )
            return deleted

    async def resolve_workspace_for_export(
        self, user_id: int, workspace_uuid: str | None = None
    ) -> int:
        from ...db.schema.init import get_or_create_user_workspace

        async with acquire_connection(self._pool) as conn:
            return await get_or_create_user_workspace(conn, user_id, workspace_uuid=workspace_uuid)

    async def seed_workspace(self, workspace_id: int, user_id: int) -> None:
        from ...db.schema.init import seed_workspace

        async with acquire_connection(self._pool) as conn:
            await seed_workspace(conn, workspace_id, user_id)

    async def ensure_user_page(self, workspace_id: int, user_id: int) -> int | None:
        async with acquire_connection(self._pool) as conn:
            existing = await conn.fetchrow(
                'SELECT user_page_node_id FROM "user" WHERE id = $1', user_id
            )
            if existing and existing["user_page_node_id"]:
                node_exists = await conn.fetchrow(
                    "SELECT 1 FROM node WHERE id = $1", existing["user_page_node_id"]
                )
                if node_exists:
                    return existing["user_page_node_id"]

            user = await conn.fetchrow(
                'SELECT email, name FROM "user" WHERE id = $1', user_id
            )
            if not user:
                return None

            display = user["name"] or user["email"]
            name_ast = [
                {"type": "paragraph", "children": [{"type": "text", "text": display}]}
            ]

            node_row = await conn.fetchrow(
                """
                INSERT INTO node (workspace_id, name, is_page, active, create_uid, write_uid)
                VALUES ($1, $2, TRUE, TRUE, $3, $3)
                RETURNING id
                """,
                workspace_id,
                serialize_ast(name_ast),
                user_id,
            )
            if not node_row:
                return None

            node_id = node_row["id"]
            await conn.execute(
                'UPDATE "user" SET user_page_node_id = $1 WHERE id = $2',
                node_id,
                user_id,
            )
            logger.info(f"Created user page node {node_id} for user {user_id}")
            return node_id

    # -------------------------------------------------------------------------
    # Membership / invite helpers (already extracted from routers/workspaces.py)
    # -------------------------------------------------------------------------

    async def get_workspace_uuid_by_name_for_user(self, name: str, user_id: int) -> str | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT g.uuid::text as uuid
                FROM workspace g
                LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
                WHERE g.name = $2 AND g.active = TRUE
                  AND (g.create_uid = $1 OR gs.user_id = $1)
                """,
                user_id,
                name,
            )
            return row["uuid"] if row else None

    async def get_workspace_id_owner(self, workspace_uuid: str) -> tuple[int, int] | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT id, create_uid
                FROM workspace
                WHERE uuid::text = $1 AND active = TRUE
                """,
                workspace_uuid,
            )
            if not row:
                return None
            return row["id"], row["create_uid"]

    async def get_sync_protocol_version(self, workspace_id: int) -> str:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT sync_protocol_version FROM workspace WHERE id = $1",
                workspace_id,
            )
            return row["sync_protocol_version"] if row else "v1"

    async def set_sync_protocol_version(self, workspace_id: int, version: str) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                UPDATE workspace
                SET sync_protocol_version = $1, write_date = NOW()
                WHERE id = $2
                """,
                version,
                workspace_id,
            )

    async def is_workspace_member(self, workspace_id: int, user_id: int) -> bool:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT 1 FROM workspace_share
                WHERE workspace_id = $1 AND user_id = $2 AND active = TRUE
                """,
                workspace_id,
                user_id,
            )
            return row is not None

    async def invite_existing_member(
        self, workspace_id: int, target_id: int, role: str, owner_id: int
    ) -> None:
        perms = _role_to_perms(role)
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                INSERT INTO workspace_share (
                    workspace_id, user_id, can_read, can_write, can_create, can_delete, can_comment,
                    active, create_uid, write_uid
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $8)
                ON CONFLICT (workspace_id, user_id)
                DO UPDATE SET
                    can_read = EXCLUDED.can_read,
                    can_write = EXCLUDED.can_write,
                    can_create = EXCLUDED.can_create,
                    can_delete = EXCLUDED.can_delete,
                    can_comment = EXCLUDED.can_comment,
                    active = TRUE,
                    write_uid = EXCLUDED.write_uid,
                    write_date = NOW()
                """,
                workspace_id,
                target_id,
                perms["can_read"],
                perms["can_write"],
                perms["can_create"],
                perms["can_delete"],
                perms["can_comment"],
                owner_id,
            )
            await conn.execute(
                "UPDATE workspace SET is_shared = TRUE WHERE id = $1",
                workspace_id,
            )

    async def create_pending_invite(
        self, workspace_id: int, email: str, role: str, invited_by: int
    ) -> str:
        invite_uuid = str(uuid.uuid4())
        expires_at = datetime.now(UTC) + timedelta(days=7)
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                INSERT INTO pending_invite (uuid, email, workspace_id, role, invited_by, expires_at, active)
                VALUES ($1, $2, $3, $4, $5, $6, TRUE)
                ON CONFLICT (email, workspace_id, node_id)
                DO UPDATE SET
                    role = EXCLUDED.role,
                    invited_by = EXCLUDED.invited_by,
                    expires_at = EXCLUDED.expires_at,
                    active = TRUE,
                    created_at = NOW()
                """,
                invite_uuid,
                email,
                workspace_id,
                role,
                invited_by,
                expires_at,
            )
        return invite_uuid

    async def list_members(
        self, workspace_id: int, page: int, page_size: int
    ) -> dict[str, Any]:
        async with acquire_connection(self._pool) as conn:
            owner_row = await conn.fetchrow(
                """
                SELECT u.id, u.email, u.uuid as user_uuid
                FROM workspace g
                JOIN "user" u ON u.id = g.create_uid
                WHERE g.id = $1
                """,
                workspace_id,
            )

            offset = (page - 1) * page_size
            if offset == 0:
                share_limit = max(0, page_size - 1) if owner_row else page_size
                share_offset = 0
            else:
                share_limit = page_size
                share_offset = max(0, offset - 1) if owner_row else offset

            rows = await conn.fetch(
                """
                SELECT u.id, u.email, u.uuid as user_uuid,
                       gs.uuid as share_uuid,
                       gs.can_read, gs.can_write, gs.can_create, gs.can_delete, gs.can_comment,
                       gs.create_date
                FROM workspace_share gs
                JOIN "user" u ON u.id = gs.user_id
                WHERE gs.workspace_id = $1 AND gs.active = TRUE
                ORDER BY gs.create_date DESC
                LIMIT $2 OFFSET $3
                """,
                workspace_id,
                share_limit,
                share_offset,
            )

            pending_rows = []
            if offset == 0:
                pending_rows = await conn.fetch(
                    """
                    SELECT uuid as invite_uuid, email, role, created_at
                    FROM pending_invite
                    WHERE workspace_id = $1 AND node_id IS NULL AND active = TRUE
                      AND (expires_at IS NULL OR expires_at > NOW())
                    ORDER BY created_at DESC
                    """,
                    workspace_id,
                )

        return {
            "owner": owner_row,
            "members": rows,
            "pending": pending_rows,
            "offset": offset,
        }

    async def update_member_role(
        self, workspace_id: int, member_user_id: int, role: str, owner_id: int
    ) -> bool:
        perms = _role_to_perms(role)
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                """
                UPDATE workspace_share
                SET can_read = $1, can_write = $2, can_create = $3, can_delete = $4, can_comment = $5,
                    write_uid = $6, write_date = NOW()
                WHERE workspace_id = $7 AND user_id = $8 AND active = TRUE
                """,
                perms["can_read"],
                perms["can_write"],
                perms["can_create"],
                perms["can_delete"],
                perms["can_comment"],
                owner_id,
                workspace_id,
                member_user_id,
            )
            return result.split()[-1] != "0"

    async def remove_member(self, workspace_id: int, member_user_id: int) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                UPDATE workspace_share
                SET active = FALSE
                WHERE workspace_id = $1 AND user_id = $2
                """,
                workspace_id,
                member_user_id,
            )

    async def remove_pending_invite(self, workspace_id: int, email: str) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                UPDATE pending_invite
                SET active = FALSE
                WHERE workspace_id = $1 AND email = $2 AND node_id IS NULL
                """,
                workspace_id,
                email,
            )

    async def mark_workspace_shared(self, workspace_id: int) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "UPDATE workspace SET is_shared = TRUE WHERE id = $1",
                workspace_id,
            )


def _role_to_perms(role: str) -> dict[str, bool]:
    defaults = {
        "viewer": {"can_read": True, "can_write": False, "can_create": False, "can_delete": False, "can_comment": False},
        "commenter": {"can_read": True, "can_write": False, "can_create": False, "can_delete": False, "can_comment": True},
        "editor": {"can_read": True, "can_write": True, "can_create": True, "can_delete": False, "can_comment": True},
        "admin": {"can_read": True, "can_write": True, "can_create": True, "can_delete": True, "can_comment": True},
    }
    return defaults.get(role, defaults["viewer"])


class PostgresWorkspaceIORepository(WorkspaceIORepository):
    """PostgreSQL adapter for workspace import/export and restore."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def export_workspace_full(self, workspace_id: int) -> dict:
        """Create a comprehensive dump of all workspace data."""
        async with acquire_connection(self._pool) as conn:
            workspace = await conn.fetchrow("SELECT uuid, name FROM workspace WHERE id = $1", workspace_id)
            if not workspace:
                raise ValueError(f"Workspace {workspace_id} not found")

            nodes = await conn.fetch(
                """
                SELECT id, uuid, name, icon, color, parent_id, page_id, sequence,
                       active, version, is_class, is_page, is_day,
                       is_month, is_year, is_asset, is_template, is_comment,
                       class_ids, tag_ids, classes_path, open_date, create_date, write_date,
                       aliased_id, is_deleted, deleted_at
                FROM node WHERE workspace_id = $1
            """,
                workspace_id,
            )

            links = await conn.fetch(
                """
                SELECT id, uuid, source_id, target_id, property_id, position,
                       is_inline_class, name, create_date
                FROM node_link WHERE workspace_id = $1
            """,
                workspace_id,
            )

            properties = await conn.fetch(
                """
                SELECT id, uuid, name, icon, type, is_multi, is_system, scope,
                       node_id, icon_visibility, active, create_date, write_date
                FROM property WHERE workspace_id = $1
            """,
                workspace_id,
            )

            selection_lines = await conn.fetch(
                """
                SELECT psl.id, psl.uuid, psl.property_id, psl.name, psl.icon,
                       psl.create_date, psl.write_date
                FROM property_selection_line psl
                JOIN property p ON psl.property_id = p.id
                WHERE p.workspace_id = $1
            """,
                workspace_id,
            )

            node_properties = await conn.fetch(
                """
                SELECT np.id, np.uuid, np.node_id, np.property_id,
                       np.create_date, np.write_date
                FROM node_property np
                JOIN node n ON np.node_id = n.id
                WHERE n.workspace_id = $1
            """,
                workspace_id,
            )

            value_scalars = await conn.fetch(
                """
                SELECT pvs.id, pvs.uuid, pvs.node_property_id, pvs.property_id,
                       pvs.node_id, pvs.value_text, pvs.value_boolean,
                       pvs.value_float, pvs.value_integer,
                       pvs.create_date, pvs.write_date
                FROM property_value_scalar pvs
                JOIN node n ON pvs.node_id = n.id
                WHERE n.workspace_id = $1
            """,
                workspace_id,
            )

            value_relations = await conn.fetch(
                """
                SELECT pvr.id, pvr.uuid, pvr.node_property_id, pvr.property_id,
                       pvr.node_id, pvr.target_id, pvr."order",
                       pvr.create_date, pvr.write_date
                FROM property_value_relation pvr
                JOIN node n ON pvr.node_id = n.id
                WHERE n.workspace_id = $1
            """,
                workspace_id,
            )

            value_selections = await conn.fetch(
                """
                SELECT pvsel.id, pvsel.uuid, pvsel.node_property_id,
                       pvsel.property_id, pvsel.node_id, pvsel.selection_line_id,
                       pvsel.create_date, pvsel.write_date
                FROM property_value_selection pvsel
                JOIN node n ON pvsel.node_id = n.id
                WHERE n.workspace_id = $1
            """,
                workspace_id,
            )

            class_properties = await conn.fetch(
                """
                SELECT cp.id, cp.class_node_id, cp.property_id, cp.sequence,
                       cp.hidden, cp.default_integer, cp.default_float,
                       cp.default_text, cp.default_boolean,
                       cp.default_node_id, cp.default_selection_id
                FROM class_property cp
                JOIN node n ON cp.class_node_id = n.id
                WHERE n.workspace_id = $1
            """,
                workspace_id,
            )

            class_extends = await conn.fetch(
                """
                SELECT ce.id, ce.target_id, ce.source_id, ce.sequence
                FROM class_extend ce
                JOIN node n ON ce.target_id = n.id
                WHERE n.workspace_id = $1
            """,
                workspace_id,
            )

            class_filters = await conn.fetch(
                """
                SELECT pcf.id, pcf.property_id, pcf.class_node_id
                FROM property_class_filter pcf
                JOIN property p ON pcf.property_id = p.id
                WHERE p.workspace_id = $1
            """,
                workspace_id,
            )

            node_views = await conn.fetch(
                """
                SELECT nv.id, nv.uuid, nv.node_id, nv.name, nv.query_json,
                       nv.view_type, nv.order_index, nv.is_default, nv.active,
                       nv.shown_properties, nv.group_by,
                       nv.create_date, nv.write_date
                FROM node_view nv
                JOIN node n ON nv.node_id = n.id
                WHERE n.workspace_id = $1
            """,
                workspace_id,
            )

            settings = await conn.fetch(
                "SELECT key, value FROM setting_workspace WHERE workspace_id = $1",
                workspace_id,
            )

        return {
            "version": 3,
            "workspace": {
                "uuid": str(workspace["uuid"]),
                "name": workspace["name"],
            },
            "nodes": [dict(r) for r in nodes],
            "links": [dict(r) for r in links],
            "properties": [dict(r) for r in properties],
            "property_selection_lines": [dict(r) for r in selection_lines],
            "node_properties": [dict(r) for r in node_properties],
            "property_value_scalars": [dict(r) for r in value_scalars],
            "property_value_relations": [dict(r) for r in value_relations],
            "property_value_selections": [dict(r) for r in value_selections],
            "class_properties": [dict(r) for r in class_properties],
            "class_extends": [dict(r) for r in class_extends],
            "property_class_filters": [dict(r) for r in class_filters],
            "node_views": [dict(r) for r in node_views],
            "settings": [dict(r) for r in settings],
        }

    async def create_workspace_for_import(self, name: str, owner_id: int) -> dict:
        """Insert a workspace for import and return the inserted row.

        Raises ValueError if the owner already has an active workspace with the
        same name, matching the original import behavior.
        """
        async with acquire_connection(self._pool) as conn, conn.transaction():
            existing = await conn.fetchrow(
                "SELECT id FROM workspace WHERE create_uid = $1 AND name = $2 AND active = TRUE",
                owner_id,
                name,
            )
            if existing:
                raise ValueError(f"Workspace '{name}' already exists")

            row = await conn.fetchrow(
                """
                INSERT INTO workspace (name, create_uid, write_uid, is_shared, active)
                VALUES ($1, $2, $2, FALSE, TRUE)
                RETURNING id, uuid, name, create_date
            """,
                name,
                owner_id,
            )
            if row is None:
                raise RuntimeError("Failed to create workspace")
            return dict(row)

    async def get_workspace_by_name_for_user(self, name: str, user_id: int) -> dict | None:
        """Get workspace row with id/uuid/name by name for a user."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT g.id, g.uuid::text as uuid, g.name
                FROM workspace g
                LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
                WHERE g.name = $2 AND g.active = TRUE
                  AND (g.create_uid = $1 OR gs.user_id = $1)
            """,
                user_id,
                name,
            )
            return dict(row) if row else None

    async def get_workspace_by_uuid_for_user(self, uuid: str, user_id: int) -> dict | None:
        """Get workspace row with id/uuid/name by uuid for a user."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT g.id, g.uuid::text as uuid, g.name
                FROM workspace g
                LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
                WHERE g.uuid::text = $2 AND g.active = TRUE
                  AND (g.create_uid = $1 OR gs.user_id = $1)
            """,
                user_id,
                uuid,
            )
            return dict(row) if row else None

    async def import_dump(
        self,
        workspace_id: int,
        user_id: int,
        dump_data: dict,
        remap_uuids: bool,
        cleanup_invalid_cloze: bool = False,
    ) -> tuple[dict, dict[str, str]]:
        """Run the entire multi-phase import inside a single DB transaction."""
        stats = {
            "nodes": 0,
            "links": 0,
            "properties": 0,
            "property_selection_lines": 0,
            "node_properties": 0,
            "property_values": 0,
            "class_properties": 0,
            "class_extends": 0,
            "property_class_filters": 0,
            "node_views": 0,
            "settings": 0,
        }

        now = datetime.now(UTC)
        async with acquire_connection(self._pool) as conn, conn.transaction():
            logger.info("Disabling node triggers for bulk import")
            await conn.execute("ALTER TABLE node DISABLE TRIGGER node_search_update")
            await conn.execute("ALTER TABLE node DISABLE TRIGGER node_write_date")
            await conn.execute("ALTER TABLE node DISABLE TRIGGER node_update_workspace_write_date")
            await conn.execute("""
                DO $$ BEGIN
                    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_node_version_capture') THEN
                        ALTER TABLE node DISABLE TRIGGER trg_node_version_capture;
                    END IF;
                END $$;
            """)

            # Phase 1: nodes
            bundle = build_import_records(dump_data, workspace_id, user_id, remap_uuids, now=now)
            node_id_map: dict[int, int] = {}

            if bundle.node_records:
                logger.info(f"Importing {len(bundle.node_records)} nodes (phase 1: batch insert)")
                await conn.executemany(
                    """
                    INSERT INTO node (
                        uuid, workspace_id, name, icon, color,
                        sequence, active, version,
                        is_class, is_page, is_day, is_month, is_year,
                        is_asset, is_template, is_comment,
                        classes_path, tag_ids, open_date, create_date, write_date,
                        is_deleted, deleted_at,
                        create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4, $5,
                        $6, $7, $8,
                        $9, $10, $11, $12, $13,
                        $14, $15, $16,
                        $17::jsonb, $18, $19, $20, $21,
                        $22, $23,
                        $24, $24
                    )
                """,
                    bundle.node_records,
                    timeout=None,
                )

                rows = await conn.fetch(
                    "SELECT id, uuid::text AS uuid_str FROM node WHERE workspace_id = $1",
                    workspace_id,
                )
                for row in rows:
                    old_id = bundle.node_uuid_to_old_id.get(row["uuid_str"])
                    if old_id is not None:
                        node_id_map[old_id] = row["id"]

            stats["nodes"] = len(node_id_map)

            # Phase 2-3: node refs + properties
            bundle = build_import_records(
                dump_data, workspace_id, user_id, remap_uuids, node_id_map=node_id_map, now=now
            )

            if bundle.node_update_records:
                logger.info("Importing nodes (phase 2: batch update references)")
                await conn.executemany(
                    """
                    UPDATE node
                    SET parent_id = $1, page_id = $2, aliased_id = $3,
                        class_ids = $4, tag_ids = $5, classes_path = $6::jsonb
                    WHERE id = $7
                """,
                    bundle.node_update_records,
                    timeout=None,
                )

            property_id_map: dict[int, int] = {}
            if bundle.property_records:
                logger.info(f"Importing {len(bundle.property_records)} properties")
                await conn.executemany(
                    """
                    INSERT INTO property (
                        uuid, workspace_id, name, icon, type, is_multi, is_system,
                        scope, node_id, icon_visibility, active,
                        create_date, write_date, create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4, $5, $6, $7,
                        $8, $9, $10, $11,
                        $12, $13, $14, $14
                    )
                """,
                    bundle.property_records,
                    timeout=None,
                )

                rows = await conn.fetch(
                    "SELECT id, uuid::text AS uuid_str FROM property WHERE workspace_id = $1",
                    workspace_id,
                )
                for row in rows:
                    old_id = bundle.property_uuid_to_old_id.get(row["uuid_str"])
                    if old_id is not None:
                        property_id_map[old_id] = row["id"]

            stats["properties"] = len(property_id_map)

            # Phase 4-6: selection lines + class filters + node properties
            bundle = build_import_records(
                dump_data,
                workspace_id,
                user_id,
                remap_uuids,
                node_id_map=node_id_map,
                property_id_map=property_id_map,
                now=now,
            )

            selection_line_id_map: dict[int, int] = {}
            if bundle.selection_line_records:
                logger.info(f"Importing {len(bundle.selection_line_records)} property selection lines")
                await conn.executemany(
                    """
                    INSERT INTO property_selection_line (
                        uuid, property_id, name, icon, create_date, write_date,
                        create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4, $5, $6, $7, $7
                    )
                """,
                    bundle.selection_line_records,
                    timeout=None,
                )

                rows = await conn.fetch(
                    """
                    SELECT psl.id, psl.uuid::text AS uuid_str
                    FROM property_selection_line psl
                    JOIN property p ON psl.property_id = p.id
                    WHERE p.workspace_id = $1
                """,
                    workspace_id,
                )
                for row in rows:
                    old_id = bundle.selection_line_uuid_to_old_id.get(row["uuid_str"])
                    if old_id is not None:
                        selection_line_id_map[old_id] = row["id"]

            stats["property_selection_lines"] = len(selection_line_id_map)

            if bundle.class_filter_records:
                logger.info(f"Importing {len(bundle.class_filter_records)} property class filters")
                await conn.executemany(
                    """
                    INSERT INTO property_class_filter (property_id, class_node_id)
                    VALUES ($1, $2)
                    ON CONFLICT (property_id, class_node_id) DO NOTHING
                """,
                    bundle.class_filter_records,
                    timeout=None,
                )
            stats["property_class_filters"] = len(bundle.class_filter_records)

            node_property_id_map: dict[int, int] = {}
            if bundle.node_property_records:
                logger.info(f"Importing {len(bundle.node_property_records)} node properties")
                await conn.executemany(
                    """
                    INSERT INTO node_property (
                        uuid, node_id, property_id, create_date, write_date,
                        create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4, $5, $6, $6
                    )
                """,
                    bundle.node_property_records,
                    timeout=None,
                )

                rows = await conn.fetch(
                    """
                    SELECT np.id, np.uuid::text AS uuid_str
                    FROM node_property np
                    JOIN node n ON np.node_id = n.id
                    WHERE n.workspace_id = $1
                """,
                    workspace_id,
                )
                for row in rows:
                    old_id = bundle.node_property_uuid_to_old_id.get(row["uuid_str"])
                    if old_id is not None:
                        node_property_id_map[old_id] = row["id"]

            stats["node_properties"] = len(node_property_id_map)

            # Phase 7-14: values, class extends, class properties, links, views, settings
            bundle = build_import_records(
                dump_data,
                workspace_id,
                user_id,
                remap_uuids,
                node_id_map=node_id_map,
                property_id_map=property_id_map,
                selection_line_id_map=selection_line_id_map,
                node_property_id_map=node_property_id_map,
                now=now,
            )

            if bundle.scalar_value_records:
                logger.info(f"Importing {len(bundle.scalar_value_records)} property value scalars")
                await conn.executemany(
                    """
                    INSERT INTO property_value_scalar (
                        uuid, node_property_id, property_id, node_id,
                        value_text, value_boolean, value_float, value_integer,
                        create_date, write_date, create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4,
                        $5, $6, $7, $8,
                        $9, $10, $11, $11
                    )
                """,
                    bundle.scalar_value_records,
                    timeout=None,
                )
            stats["property_values"] = len(bundle.scalar_value_records)

            if bundle.relation_value_records:
                logger.info(f"Importing {len(bundle.relation_value_records)} property value relations")
                await conn.executemany(
                    """
                    INSERT INTO property_value_relation (
                        uuid, node_property_id, property_id, node_id, target_id,
                        "order", create_date, write_date, create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4, $5,
                        $6, $7, $8, $9, $9
                    )
                """,
                    bundle.relation_value_records,
                    timeout=None,
                )
            stats["property_values"] += len(bundle.relation_value_records)

            if bundle.selection_value_records:
                logger.info(f"Importing {len(bundle.selection_value_records)} property value selections")
                await conn.executemany(
                    """
                    INSERT INTO property_value_selection (
                        uuid, node_property_id, property_id, node_id,
                        selection_line_id, create_date, write_date,
                        create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4,
                        $5, $6, $7,
                        $8, $8
                    )
                """,
                    bundle.selection_value_records,
                    timeout=None,
                )
            stats["property_values"] += len(bundle.selection_value_records)

            if bundle.class_extend_records:
                logger.info(f"Importing {len(bundle.class_extend_records)} class extends")
                await conn.executemany(
                    """
                    INSERT INTO class_extend (target_id, source_id, sequence)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (target_id, source_id) DO NOTHING
                """,
                    bundle.class_extend_records,
                    timeout=None,
                )
            stats["class_extends"] = len(bundle.class_extend_records)

            if bundle.class_property_records:
                logger.info(f"Importing {len(bundle.class_property_records)} class properties")
                await conn.executemany(
                    """
                    INSERT INTO class_property (
                        class_node_id, property_id, sequence, hidden,
                        default_integer, default_float, default_text,
                        default_boolean, default_node_id, default_selection_id
                    ) VALUES (
                        $1, $2, $3, $4,
                        $5, $6, $7,
                        $8, $9, $10
                    )
                    ON CONFLICT (class_node_id, property_id) DO NOTHING
                """,
                    bundle.class_property_records,
                    timeout=None,
                )
            stats["class_properties"] = len(bundle.class_property_records)

            if bundle.link_records:
                logger.info(f"Importing {len(bundle.link_records)} node links")
                await conn.executemany(
                    """
                    INSERT INTO node_link (
                        uuid, source_id, target_id, workspace_id, property_id,
                        position, is_inline_class, name, create_date,
                        create_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4, $5,
                        $6, $7, $8, $9,
                        $10
                    )
                """,
                    bundle.link_records,
                    timeout=None,
                )

            if bundle.tag_links_by_source:
                tag_update_records = [(list(targets), source_id) for source_id, targets in bundle.tag_links_by_source.items()]
                await conn.executemany(
                    """
                    UPDATE node
                    SET tag_ids = (
                        SELECT ARRAY_AGG(DISTINCT x ORDER BY x)
                        FROM unnest(COALESCE(tag_ids, '{}') || $1::INTEGER[]) AS x
                    )
                    WHERE id = $2
                """,
                    tag_update_records,
                    timeout=None,
                )
            stats["links"] = len(bundle.link_records)

            if bundle.node_view_records:
                logger.info(f"Importing {len(bundle.node_view_records)} node views")
                await conn.executemany(
                    """
                    INSERT INTO node_view (
                        uuid, node_id, name, query_json, view_type,
                        order_index, is_default, active,
                        shown_properties, group_by,
                        create_date, write_date, create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4::jsonb, $5,
                        $6, $7, $8,
                        $9::jsonb, $10,
                        $11, $12, $13, $13
                    )
                    ON CONFLICT (uuid) DO UPDATE SET
                        node_id = EXCLUDED.node_id,
                        name = EXCLUDED.name,
                        query_json = EXCLUDED.query_json,
                        view_type = EXCLUDED.view_type,
                        order_index = EXCLUDED.order_index,
                        is_default = EXCLUDED.is_default,
                        active = EXCLUDED.active,
                        shown_properties = EXCLUDED.shown_properties,
                        group_by = EXCLUDED.group_by,
                        write_date = EXCLUDED.write_date,
                        write_uid = EXCLUDED.write_uid
                """,
                    bundle.node_view_records,
                    timeout=None,
                )
            stats["node_views"] = len(bundle.node_view_records)

            if bundle.settings_records:
                logger.info(f"Importing {len(bundle.settings_records)} workspace settings")
                await conn.executemany(
                    """
                    INSERT INTO setting_workspace (workspace_id, key, value,
                                                   create_date, write_date,
                                                   create_uid, write_uid)
                    VALUES ($1, $2, $3::jsonb, $4, $4, $5, $5)
                    ON CONFLICT (workspace_id, key) DO UPDATE
                        SET value = EXCLUDED.value, write_date = EXCLUDED.write_date
                """,
                    bundle.settings_records,
                    timeout=None,
                )
            stats["settings"] = len(bundle.settings_records)

            if cleanup_invalid_cloze:
                stats["invalid_cloze_cleaned"] = await self._cleanup_invalid_cloze_assignments(
                    conn, workspace_id
                )

            logger.info("Re-enabling node triggers")
            await conn.execute("ALTER TABLE node ENABLE TRIGGER node_search_update")
            await conn.execute("ALTER TABLE node ENABLE TRIGGER node_write_date")
            await conn.execute("ALTER TABLE node ENABLE TRIGGER node_update_workspace_write_date")
            await conn.execute("""
                DO $$ BEGIN
                    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_node_version_capture') THEN
                        ALTER TABLE node ENABLE TRIGGER trg_node_version_capture;
                    END IF;
                END $$;
            """)

            logger.info("Rebuilding search vectors for imported nodes")
            await conn.execute(
                """
                UPDATE node SET search_vector = to_tsvector(
                    COALESCE(search_language, 'english')::regconfig,
                    COALESCE(name, '')
                ) WHERE workspace_id = $1
            """,
                workspace_id,
                timeout=None,
            )

        logger.info(f"Import complete: {stats}")
        return stats, bundle.uuid_map

    async def _cleanup_invalid_cloze_assignments(
        self, conn: asyncpg.Connection, workspace_id: int
    ) -> int:
        """Remove the cloze class from nodes that are not direct children of a card.

        This is useful as an opt-in correction after importing a workspace dump
        that may contain inconsistent cloze assignments.
        """
        cloze_uuid = SYSTEM_CLASS_UUIDS["cloze"]
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE workspace_id = $1 AND uuid = $2 AND active = TRUE",
            workspace_id,
            cloze_uuid,
        )
        if not row:
            return 0
        cloze_class_id = row["id"]

        result = await conn.fetchval(
            """
            WITH cleaned AS (
                UPDATE node n
                SET class_ids = array_remove(n.class_ids, $2),
                    is_cloze = FALSE
                WHERE n.workspace_id = $1
                  AND n.is_cloze = TRUE
                  AND $2 = ANY(n.class_ids)
                  AND (
                      n.parent_id IS NULL
                      OR NOT EXISTS (
                          SELECT 1 FROM node p
                          WHERE p.id = n.parent_id AND p.is_card = TRUE
                      )
                  )
                RETURNING n.id
            )
            SELECT COUNT(*) FROM cleaned
            """,
            workspace_id,
            cloze_class_id,
        )
        count = int(result or 0)
        if count > 0:
            logger.info(f"Cleaned up {count} invalid cloze assignment(s) in workspace {workspace_id}")
        return count

    async def delete_all_workspace_data(self, workspace_id: int) -> None:
        """Delete all data in a workspace."""
        async with acquire_connection(self._pool) as conn, conn.transaction():
            await conn.execute(
                """
                DELETE FROM node_view
                WHERE node_id IN (SELECT id FROM node WHERE workspace_id = $1)
            """,
                workspace_id,
            )
            await conn.execute("DELETE FROM node_link WHERE workspace_id = $1", workspace_id)
            await conn.execute("DELETE FROM setting_workspace WHERE workspace_id = $1", workspace_id)
            await conn.execute("DELETE FROM node WHERE workspace_id = $1", workspace_id)
            await conn.execute("DELETE FROM property WHERE workspace_id = $1", workspace_id)

    async def restore_workspace(
        self,
        workspace_id: int,
        user_id: int,
        dump_data: dict,
        cleanup_invalid_cloze: bool = False,
    ) -> dict:
        """Delete all data then import with remap_uuids=False."""
        await self.delete_all_workspace_data(workspace_id)
        stats, _ = await self.import_dump(
            workspace_id, user_id, dump_data, remap_uuids=False, cleanup_invalid_cloze=cleanup_invalid_cloze
        )
        return stats

    async def list_page_uuids(self, workspace_id: int) -> list[dict]:
        """List active page UUIDs and names."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT uuid::text as uuid, name
                FROM node
                WHERE workspace_id = $1 AND is_page = TRUE
                  AND is_deleted = FALSE AND active = TRUE
                ORDER BY sequence, id
            """,
                workspace_id,
            )
            return [dict(r) for r in rows]

    async def list_asset_uuids(self, workspace_id: int) -> list[dict]:
        """List active asset UUIDs and names."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT n.uuid::text as uuid, n.name
                FROM node n
                WHERE n.workspace_id = $1 AND n.is_asset = TRUE
                  AND n.is_deleted = FALSE AND n.active = TRUE
            """,
                workspace_id,
            )
            return [dict(r) for r in rows]

    async def get_page_metadata(
        self, workspace_id: int, node_uuid: str, include_properties: bool = True
    ) -> dict[str, Any]:
        """Fetch full page metadata for YAML frontmatter."""
        async with acquire_connection(self._pool) as conn:
            node_row = await conn.fetchrow(
                """
                SELECT id, uuid::text as uuid, name, is_page, is_day, is_month, is_year,
                       color, icon, class_ids, tag_ids, parent_id, create_date, write_date
                FROM node
                WHERE workspace_id = $1 AND uuid::text = $2
                """,
                workspace_id,
                node_uuid,
            )
            if not node_row:
                raise ValueError(f"Node not found: {node_uuid}")

            metadata: dict[str, Any] = {
                "uuid": str(node_row["uuid"]),
                "create_date": node_row["create_date"].isoformat() if node_row["create_date"] else None,
                "write_date": node_row["write_date"].isoformat() if node_row["write_date"] else None,
            }

            metadata["title"] = self._extract_plain_text(node_row["name"])

            if node_row["color"]:
                metadata["color"] = node_row["color"]

            ancestor_rows = await conn.fetch(
                """
                WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id, 0 AS depth
                    FROM node
                    WHERE id = $1
                    UNION ALL
                    SELECT n.id, n.parent_id, a.depth + 1
                    FROM node n
                    INNER JOIN ancestors a ON n.id = a.parent_id
                )
                SELECT n.uuid::text as uuid, n.name
                FROM ancestors a
                JOIN node n ON n.id = a.id
                WHERE a.depth > 0
                ORDER BY a.depth DESC
                """,
                node_row["id"],
            )
            if ancestor_rows:
                metadata["parents"] = [
                    {"uuid": str(row["uuid"]), "title": self._extract_plain_text(row["name"])}
                    for row in ancestor_rows
                ]

            tag_rows = await conn.fetch(
                """
                SELECT n.uuid::text as uuid, n.name
                FROM node n
                WHERE n.id = ANY($1) AND n.active = TRUE
                ORDER BY n.name
                """,
                list(node_row["tag_ids"] or []),
            )
            if tag_rows:
                metadata["tags"] = [
                    {"uuid": str(row["uuid"]), "name": self._extract_plain_text(row["name"])}
                    for row in tag_rows
                ]

            class_ids = list(node_row["class_ids"] or [])
            if class_ids:
                class_rows = await conn.fetch(
                    "SELECT id, uuid::text as uuid, name FROM node WHERE id = ANY($1) AND active = TRUE",
                    class_ids,
                )
                metadata["classes"] = [
                    {"uuid": str(row["uuid"]), "name": self._extract_plain_text(row["name"])}
                    for row in class_rows
                ]

            if include_properties:
                prop_rows = await conn.fetch(
                    """
                    SELECT p.name AS property_name, p.type AS property_type, p.is_multi,
                           pvs.value_text, pvs.value_boolean, pvs.value_float, pvs.value_integer,
                           psl.name AS selection_value,
                           pvr.target_id AS relation_target_id,
                           rel.uuid::text AS relation_target_uuid, rel.name AS relation_target_name
                    FROM node_property np
                    JOIN property p ON p.id = np.property_id
                    LEFT JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                    LEFT JOIN property_value_relation pvr ON pvr.node_property_id = np.id
                    LEFT JOIN property_value_selection pvsel ON pvsel.node_property_id = np.id
                    LEFT JOIN property_selection_line psl ON psl.id = pvsel.selection_line_id
                    LEFT JOIN node rel ON rel.id = pvr.target_id
                    WHERE np.node_id = $1 AND p.active = TRUE
                    ORDER BY p.name
                    """,
                    node_row["id"],
                )
                props_agg: dict[str, dict] = {}
                for row in prop_rows:
                    prop_name = row["property_name"]
                    prop_type = row["property_type"]
                    if prop_name not in props_agg:
                        props_agg[prop_name] = {"type": prop_type, "values": []}
                    value = None
                    if prop_type == "integer" and row["value_integer"] is not None:
                        value = row["value_integer"]
                    elif prop_type == "float" and row["value_float"] is not None:
                        value = row["value_float"]
                    elif prop_type == "boolean" and row["value_boolean"] is not None:
                        value = bool(row["value_boolean"])
                    elif prop_type == "date" and row["value_text"] is not None:
                        value = row["value_text"]
                    elif prop_type == "selection" and row["selection_value"] is not None:
                        value = row["selection_value"]
                    elif prop_type in ("node", "text") and row["relation_target_id"] is not None:
                        value = {
                            "uuid": str(row["relation_target_uuid"]) if row["relation_target_uuid"] else None,
                            "name": self._extract_plain_text(row["relation_target_name"]),
                        }
                    if value is not None and value not in props_agg[prop_name]["values"]:
                        props_agg[prop_name]["values"].append(value)

                if props_agg:
                    props_out = {}
                    for prop_name, prop_data in props_agg.items():
                        values = prop_data["values"]
                        prop_type = prop_data["type"]
                        if not values:
                            continue
                        if len(values) == 1 and prop_type != "text":
                            props_out[prop_name] = values[0]
                        else:
                            props_out[prop_name] = values
                    if props_out:
                        metadata["properties"] = props_out

            if node_row["icon"]:
                metadata["icon"] = node_row["icon"]

            return metadata

    @staticmethod
    def _extract_plain_text(name: str | None) -> str:
        if not name:
            return "untitled"
        try:
            ast = parse_ast(name)
            opts = StringifyOptions(mode=StringifyMode.TEXT_ONLY)
            return stringify_ast(ast, opts) or "untitled"
        except (ValueError, TypeError):
            return name.strip() or "untitled"
