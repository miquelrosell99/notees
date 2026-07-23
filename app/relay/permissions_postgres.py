"""PostgreSQL-backed permission checker for the operation relay."""

from __future__ import annotations

import asyncpg

from app.db.connection import acquire_connection
from app.relay.permissions import PermissionChecker


class PostgresPermissionChecker(PermissionChecker):
    """Permission checker backed by workspace membership and public-share tables."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def _resolve_user_id(self, actor_id: str) -> int | None:
        """Map an actor UUID string to the internal numeric user id."""
        if actor_id == "anonymous":
            return None
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                'SELECT id FROM "user" WHERE uuid::text = $1 AND active = TRUE',
                actor_id,
            )
            return row["id"] if row else None

    async def can_read(self, workspace_id: str, actor_id: str) -> bool:
        """Return ``True`` if the actor is the owner or has an active read share."""
        user_id = await self._resolve_user_id(actor_id)
        if user_id is None:
            return False

        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT 1
                FROM workspace g
                WHERE g.uuid::text = $1 AND g.active = TRUE
                  AND (
                      g.create_uid = $2
                      OR EXISTS (
                          SELECT 1 FROM workspace_share gs
                          WHERE gs.workspace_id = g.id
                            AND gs.user_id = $2
                            AND gs.active = TRUE
                            AND gs.can_read = TRUE
                      )
                  )
                """,
                workspace_id,
                user_id,
            )
            return row is not None

    async def can_write(
        self,
        workspace_id: str,
        actor_id: str,
        affected_node_ids: list[str],
    ) -> bool:
        """Return ``True`` if the actor is the owner or has an active write share.

        Public-share tokens are read-only and anonymous actors are never
        permitted to write.
        """
        if actor_id == "anonymous":
            return False

        user_id = await self._resolve_user_id(actor_id)
        if user_id is None:
            return False

        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT 1
                FROM workspace g
                WHERE g.uuid::text = $1 AND g.active = TRUE
                  AND (
                      g.create_uid = $2
                      OR EXISTS (
                          SELECT 1 FROM workspace_share gs
                          WHERE gs.workspace_id = g.id
                            AND gs.user_id = $2
                            AND gs.active = TRUE
                            AND gs.can_write = TRUE
                      )
                  )
                """,
                workspace_id,
                user_id,
            )
            return row is not None

    async def can_read_public_share(
        self,
        workspace_id: str,
        share_token: str,
        node_id: str | None = None,
    ) -> bool:
        """Return ``True`` if an active, unexpired public share matches the token.

        When ``node_id`` is supplied, the share must be for that exact node.
        When ``node_id`` is ``None``, any active unexpired share in the workspace
        is sufficient (used by the catch-up prototype).
        """
        async with acquire_connection(self._pool) as conn:
            if node_id is not None:
                row = await conn.fetchrow(
                    """
                    SELECT 1
                    FROM node_public_share s
                    JOIN workspace w ON w.id = s.workspace_id
                    WHERE s.uuid::text = $1
                      AND s.node_uuid::text = $2
                      AND w.uuid::text = $3
                      AND s.active = TRUE
                      AND (s.expiry_date IS NULL OR s.expiry_date > NOW())
                    """,
                    share_token,
                    node_id,
                    workspace_id,
                )
                return row is not None

            row = await conn.fetchrow(
                """
                SELECT 1
                FROM node_public_share s
                JOIN workspace w ON w.id = s.workspace_id
                WHERE s.uuid::text = $1
                  AND w.uuid::text = $2
                  AND s.active = TRUE
                  AND (s.expiry_date IS NULL OR s.expiry_date > NOW())
                LIMIT 1
                """,
                share_token,
                workspace_id,
            )
            return row is not None

    async def get_public_share_node_id(
        self,
        workspace_id: str,
        share_token: str,
    ) -> str | None:
        """Return the node UUID that an active public share token references."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT s.node_uuid::text as node_uuid
                FROM node_public_share s
                JOIN workspace w ON w.id = s.workspace_id
                WHERE s.uuid::text = $1
                  AND w.uuid::text = $2
                  AND s.active = TRUE
                  AND (s.expiry_date IS NULL OR s.expiry_date > NOW())
                LIMIT 1
                """,
                share_token,
                workspace_id,
            )
            return row["node_uuid"] if row else None
