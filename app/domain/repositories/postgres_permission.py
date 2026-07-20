"""PostgreSQL implementation of the PermissionRepository port.

Workspace membership and workspace-level sharing remain in PostgreSQL.
Node information and node-level sharing are read from the derived SQLite
state via :class:`app.core.workspace_store.WorkspaceStore`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ...core.workspace_store import WorkspaceStore
from ...db.connection import acquire_connection
from ..permissions import Permissions
from .base import BasePostgresRepository
from .interfaces import PermissionRepository

if TYPE_CHECKING:
    import asyncpg


class PostgresPermissionRepository(BasePostgresRepository, PermissionRepository):
    """PostgreSQL permission queries backed by the derived SQLite store for node data."""

    def __init__(
        self,
        pool: asyncpg.Pool,
        workspace_id: int,
        user_id: int | None = None,
    ) -> None:
        super().__init__(pool, workspace_id, user_id)
        self._workspace_uuid: str | None = None
        self._user_uuid: str | None = None
        self._workspace_store: WorkspaceStore | None = None

    async def _ensure_workspace_uuid(self) -> str | None:
        """Resolve and cache the workspace UUID for ``self._workspace_id``."""
        if self._workspace_uuid is None:
            async with acquire_connection(self._pool) as conn:
                row = await conn.fetchrow(
                    "SELECT uuid::text FROM workspace WHERE id = $1 AND active = TRUE",
                    self._workspace_id,
                )
                self._workspace_uuid = row["uuid"] if row else None
        return self._workspace_uuid

    async def _ensure_user_uuid(self) -> str | None:
        """Resolve and cache the user UUID for ``self._user_id``."""
        if self._user_id is None:
            return None
        if self._user_uuid is None:
            async with acquire_connection(self._pool) as conn:
                row = await conn.fetchrow(
                    'SELECT uuid::text FROM "user" WHERE id = $1 AND active = TRUE',
                    self._user_id,
                )
                self._user_uuid = row["uuid"] if row else None
        return self._user_uuid

    async def _ensure_workspace_store(self) -> WorkspaceStore | None:
        """Open and sync the derived SQLite store for the current workspace."""
        if self._workspace_store is not None:
            return self._workspace_store

        workspace_uuid = await self._ensure_workspace_uuid()
        if workspace_uuid is None:
            return None

        user_uuid = await self._ensure_user_uuid()
        actor_id = user_uuid or (str(self._user_id) if self._user_id is not None else "system")
        self._workspace_store = WorkspaceStore(
            workspace_id=workspace_uuid,
            actor_id=actor_id,
        )
        await self._workspace_store.sync()
        return self._workspace_store

    async def _resolve_uuid_to_user_id(self, user_uuid: str | None) -> int | None:
        """Map a user UUID back to the internal numeric user id."""
        if user_uuid is None:
            return None
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                'SELECT id FROM "user" WHERE uuid::text = $1 AND active = TRUE',
                user_uuid,
            )
            return row["id"] if row else None

    async def _node_has_shares(self, store: WorkspaceStore, node_uuid: str) -> bool:
        """Return True when the node has any user or public share in derived state."""
        rows = await store.query(
            """
            SELECT 1 FROM node_user_share WHERE node_id = ?
            UNION ALL
            SELECT 1 FROM node_public_share WHERE node_id = ?
            LIMIT 1
            """,
            (node_uuid, node_uuid),
        )
        return bool(rows)

    @staticmethod
    def _decode_share_permissions(permission_bits: int) -> Permissions:
        """Decode a node share permission bitmask into a :class:`Permissions`."""
        return Permissions(
            can_read=bool(permission_bits & 1),
            can_write=bool(permission_bits & 2),
            can_create=bool(permission_bits & 4),
            can_delete=bool(permission_bits & 8),
            can_comment=False,
        )

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
        """Return node workspace_id, create_uid, is_private and is_shared row.

        The derived ``node`` table has no ``active`` column, so ``active_only``
        is currently ignored: any existing node row is treated as active. The
        derived schema also has no ``is_private`` flag; it is always returned as
        ``False`` here. ``is_shared`` is derived from the presence of any
        ``node_user_share`` or ``node_public_share`` row for the node.
        """
        store = await self._ensure_workspace_store()
        if store is None:
            return None

        rows = await store.query(
            "SELECT created_by FROM node WHERE id = ?",
            (node_uuid,),
        )
        if not rows:
            return None

        create_uid = await self._resolve_uuid_to_user_id(rows[0]["created_by"])
        is_shared = await self._node_has_shares(store, node_uuid)
        return {
            "workspace_id": self._workspace_id,
            "create_uid": create_uid,
            "is_private": False,
            "is_shared": is_shared,
        }

    async def get_node_share(self, node_uuid: str, user_id: int) -> Permissions | None:
        """Return explicit node_user_share permissions for a user, or None."""
        store = await self._ensure_workspace_store()
        if store is None:
            return None

        user_uuid = await self._ensure_user_uuid()
        if user_uuid is None:
            return None

        rows = await store.query(
            """
            SELECT permission_bits
            FROM node_user_share
            WHERE node_id = ? AND target_user_id = ?
            """,
            (node_uuid, user_uuid),
        )
        if not rows:
            return None
        return self._decode_share_permissions(rows[0]["permission_bits"])

    async def get_ancestor_node_share(self, node_uuid: str, user_id: int) -> Permissions | None:
        """Return inherited share permissions from the closest ancestor page."""
        store = await self._ensure_workspace_store()
        if store is None:
            return None

        user_uuid = await self._ensure_user_uuid()
        if user_uuid is None:
            return None

        rows = await store.query(
            """
            WITH RECURSIVE ancestors AS (
                SELECT id, parent_id, 0 AS depth
                FROM node
                WHERE id = ?
                UNION ALL
                SELECT n.id, n.parent_id, a.depth + 1
                FROM node n
                INNER JOIN ancestors a ON n.id = a.parent_id
            )
            SELECT nus.permission_bits
            FROM ancestors a
            JOIN node n ON n.id = a.id
            JOIN node_user_share nus ON nus.node_id = n.id
            WHERE a.depth > 0
              AND n.kind = 'page'
              AND nus.target_user_id = ?
            ORDER BY a.depth ASC
            LIMIT 1
            """,
            (node_uuid, user_uuid),
        )
        if not rows:
            return None
        return self._decode_share_permissions(rows[0]["permission_bits"])

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

    async def close(self) -> None:
        """Close the derived SQLite store if it was opened."""
        if self._workspace_store is not None:
            await self._workspace_store.close()
            self._workspace_store = None
