"""PostgreSQL implementation of the PermissionRepository port.

All SQL that was previously embedded in PermissionChecker lives here.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ...db.connection import acquire_connection
from ..permissions import Permissions
from .base import BasePostgresRepository
from .interfaces import PermissionRepository

if TYPE_CHECKING:
    pass


class PostgresPermissionRepository(BasePostgresRepository, PermissionRepository):
    """PostgreSQL permission queries."""

    async def get_workspace_owner(self, workspace_id: int) -> int | None:
        """Return the create_uid of the active workspace, or None if not found."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT create_uid FROM workspace
                WHERE id = $1 AND active = TRUE
                """,
                workspace_id,
            )
            return row["create_uid"] if row else None

    async def get_workspace_share(self, workspace_id: int, user_id: int) -> Permissions | None:
        """Return workspace-level share permissions for a user, or None."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT can_read, can_write, can_create, can_delete, can_comment
                FROM workspace_share
                WHERE workspace_id = $1 AND user_id = $2 AND active = TRUE
                """,
                workspace_id,
                user_id,
            )
            if not row:
                return None
            return Permissions(
                can_read=row["can_read"],
                can_write=row["can_write"],
                can_create=row["can_create"],
                can_delete=row["can_delete"],
                can_comment=row["can_comment"],
            )

    async def get_node_info(self, node_uuid: str, active_only: bool) -> dict[str, Any] | None:
        """Return node workspace_id, create_uid, is_private (and is_shared) row."""
        async with acquire_connection(self._pool) as conn:
            if active_only:
                row = await conn.fetchrow(
                    """
                    SELECT workspace_id, create_uid, is_shared, is_private FROM node
                    WHERE uuid = $1 AND active = TRUE
                    """,
                    node_uuid,
                )
            else:
                row = await conn.fetchrow(
                    """
                    SELECT workspace_id, create_uid, is_shared, is_private FROM node
                    WHERE uuid = $1
                    """,
                    node_uuid,
                )
            return dict(row) if row else None

    async def get_node_share(self, node_uuid: str, user_id: int) -> Permissions | None:
        """Return explicit node_share permissions for a user, or None."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT can_read, can_write, can_create, can_delete, can_comment
                FROM node_share
                WHERE node_uuid = $1 AND user_id = $2 AND active = TRUE
                """,
                node_uuid,
                user_id,
            )
            if not row:
                return None
            return Permissions(
                can_read=row["can_read"],
                can_write=row["can_write"],
                can_create=row["can_create"],
                can_delete=row["can_delete"],
                can_comment=row["can_comment"],
            )

    async def get_ancestor_node_share(self, node_uuid: str, user_id: int) -> Permissions | None:
        """Return inherited share permissions from the closest ancestor page."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id, 0 AS depth
                    FROM node
                    WHERE uuid = $1
                    UNION ALL
                    SELECT n.id, n.parent_id, a.depth + 1
                    FROM node n
                    INNER JOIN ancestors a ON n.id = a.parent_id
                )
                SELECT ns.can_read, ns.can_write, ns.can_create, ns.can_delete, ns.can_comment
                FROM ancestors a
                JOIN node n ON n.id = a.id
                JOIN node_share ns ON ns.node_uuid = n.uuid
                WHERE a.depth > 0
                  AND n.is_page = TRUE
                  AND ns.user_id = $2
                  AND ns.active = TRUE
                ORDER BY a.depth ASC
                LIMIT 1
                """,
                node_uuid,
                user_id,
            )
            if not row:
                return None
            return Permissions(
                can_read=row["can_read"],
                can_write=row["can_write"],
                can_create=row["can_create"],
                can_delete=row["can_delete"],
                can_comment=row["can_comment"],
            )

    async def get_accessible_workspace_ids(self, user_id: int) -> list[int]:
        """Return all workspace IDs the user can read (owned + shared)."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT DISTINCT id FROM (
                    -- Workspaces owned by user
                    SELECT id FROM workspace WHERE create_uid = $1 AND active = TRUE
                    UNION
                    -- Workspaces shared with user (with read permission)
                    SELECT g.id FROM workspace g
                    JOIN workspace_share gs ON g.id = gs.workspace_id
                    WHERE gs.user_id = $1 AND gs.can_read = TRUE AND gs.active = TRUE AND g.active = TRUE
                ) AS accessible_workspaces
                ORDER BY id
                """,
                user_id,
            )
            return [row["id"] for row in rows]
