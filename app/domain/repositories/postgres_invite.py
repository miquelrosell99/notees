"""PostgreSQL implementation of InviteRepository."""

from __future__ import annotations

from typing import Any

import asyncpg

from ...db.connection import acquire_connection
from .base import BasePostgresRepository
from .interfaces import InviteRepository


class PostgresInviteRepository(BasePostgresRepository, InviteRepository):
    """Handles pending invite lookup and share creation."""

    def __init__(self, pool: asyncpg.Pool, workspace_id: int = 0, user_id: int | None = None):
        super().__init__(pool, workspace_id, user_id)

    async def get_pending_invite(self, token: str) -> Any | None:
        """Get an active pending invite by its UUID token."""
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchrow(
                """
                SELECT id, email, workspace_id, node_id, role, invited_by, expires_at
                FROM pending_invite
                WHERE uuid::text = $1 AND active = TRUE
                """,
                token,
            )

    async def expire_invite(self, invite_id: int) -> None:
        """Mark a pending invite as inactive."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "UPDATE pending_invite SET active = FALSE WHERE id = $1",
                invite_id,
            )

    async def apply_invite_shares(
        self,
        invite: Any,
        user_id: int,
    ) -> None:
        """Create workspace/node shares from an invite in a single transaction."""
        async with acquire_connection(self._pool) as conn, conn.transaction():
            if invite["workspace_id"]:
                perms = {
                    "viewer": (True, False, False, False, False),
                    "commenter": (True, False, False, False, True),
                    "editor": (True, True, True, False, True),
                    "admin": (True, True, True, True, True),
                }.get(invite["role"], (True, False, False, False, False))

                await conn.execute(
                    """
                    INSERT INTO workspace_share (workspace_id, user_id, can_read, can_write, can_create, can_delete, can_comment, active, create_uid, write_uid)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $8)
                    ON CONFLICT (workspace_id, user_id)
                    DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write,
                                  can_create = EXCLUDED.can_create, can_delete = EXCLUDED.can_delete,
                                  can_comment = EXCLUDED.can_comment, active = TRUE, write_uid = EXCLUDED.write_uid,
                                  write_date = NOW()
                    """,
                    invite["workspace_id"],
                    user_id,
                    perms[0],
                    perms[1],
                    perms[2],
                    perms[3],
                    perms[4],
                    invite["invited_by"],
                )
                await conn.execute(
                    "UPDATE workspace SET is_shared = TRUE WHERE id = $1",
                    invite["workspace_id"],
                )

            if invite["node_id"]:
                can_write = invite["role"] == "write"
                await conn.execute(
                    """
                    INSERT INTO node_share (node_id, user_id, can_read, can_write, can_create, can_delete, can_comment, active, create_uid, write_uid)
                    VALUES ($1, $2, TRUE, $3, FALSE, FALSE, FALSE, TRUE, $4, $4)
                    ON CONFLICT (node_id, user_id)
                    DO UPDATE SET can_read = TRUE, can_write = EXCLUDED.can_write, active = TRUE,
                                  write_uid = EXCLUDED.write_uid, write_date = NOW()
                    """,
                    invite["node_id"],
                    user_id,
                    can_write,
                    invite["invited_by"],
                )
                await conn.execute(
                    "UPDATE node SET is_shared = TRUE WHERE id = $1",
                    invite["node_id"],
                )

            await conn.execute(
                "UPDATE pending_invite SET active = FALSE WHERE id = $1",
                invite["id"],
            )
