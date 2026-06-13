"""PostgreSQL implementation of WorkspaceRepository."""

from __future__ import annotations

import shutil
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg

from ...db.connection import acquire_connection, get_workspace_dir
from ...domain.stringify_ast import serialize_ast
from ...logging_config import get_logger
from .interfaces import WorkspaceRepository

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
                    SELECT email, role, created_at
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
