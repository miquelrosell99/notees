"""PostgreSQL implementation of ShareRepository."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg

from app.db.connection import acquire_connection
from app.domain.entities.share import PublicShare
from app.domain.repositories.base import BasePostgresRepository

from .port import ShareRepository


class PostgresShareRepository(BasePostgresRepository, ShareRepository):
    """Handles public share link CRUD."""

    def __init__(self, pool: asyncpg.Pool, workspace_id: int, user_id: int | None = None):
        super().__init__(pool, workspace_id, user_id)

    @staticmethod
    def _row_to_share(row: asyncpg.Record) -> PublicShare:
        return PublicShare(
            id=row["id"],
            uuid=str(row["uuid"]),
            node_uuid=str(row["node_uuid"]),
            workspace_id=row["workspace_id"],
            created_by=row["created_by"],
            created_at=row["created_at"].isoformat() if row["created_at"] else "",
            expiry_date=row["expiry_date"].isoformat() if row["expiry_date"] else None,
            password_hash=row.get("password_hash"),
            active=row["active"],
        )

    async def create_share(
        self,
        node_uuid: str,
        workspace_id: int,
        created_by: int,
        expiry_date: str | None = None,
    ) -> PublicShare:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO node_public_share (node_uuid, workspace_id, created_by, expiry_date)
                VALUES ($1, $2, $3, $4)
                RETURNING id, uuid, node_uuid, workspace_id, created_by, created_at, expiry_date, password_hash, active
                """,
                node_uuid,
                workspace_id,
                created_by,
                expiry_date,
            )
        assert row is not None
        return self._row_to_share(row)

    async def get_share_by_uuid(self, share_uuid: str) -> PublicShare | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT id, uuid, node_uuid, workspace_id, created_by, created_at, expiry_date, password_hash, active
                FROM node_public_share
                WHERE uuid = $1
                """,
                share_uuid,
            )
        if row is None:
            return None
        return self._row_to_share(row)

    async def list_shares_for_node(self, node_uuid: str) -> list[PublicShare]:
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, uuid, node_uuid, workspace_id, created_by, created_at, expiry_date, password_hash, active
                FROM node_public_share
                WHERE node_uuid = $1 AND active = TRUE
                ORDER BY created_at DESC
                """,
                node_uuid,
            )
        return [self._row_to_share(row) for row in rows]

    async def list_shares_for_workspace(self, workspace_id: int) -> list[PublicShare]:
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, uuid, node_uuid, workspace_id, created_by, created_at, expiry_date, password_hash, active
                FROM node_public_share
                WHERE workspace_id = $1 AND active = TRUE
                ORDER BY created_at DESC
                """,
                workspace_id,
            )
        return [self._row_to_share(row) for row in rows]

    async def delete_share(self, share_uuid: str) -> bool:
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "UPDATE node_public_share SET active = FALSE WHERE uuid = $1",
                share_uuid,
            )
        # asyncpg returns e.g. "UPDATE 1"
        return result.split()[-1] != "0"

    async def get_shared_node(self, share_uuid: str) -> dict[str, Any] | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT node_uuid
                FROM node_public_share
                WHERE uuid = $1 AND active = TRUE
                  AND (expiry_date IS NULL OR expiry_date > NOW())
                """,
                share_uuid,
            )
        if row is None:
            return None
        return {"node_uuid": str(row["node_uuid"])}

    async def set_share_password(self, share_id: int, password_hash: str) -> None:
        """Set a password hash on a public share."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "UPDATE node_public_share SET password_hash = $1 WHERE id = $2",
                password_hash,
                share_id,
            )

    async def list_share_inbox(
        self, user_id: int, page: int, page_size: int
    ) -> tuple[int, list[asyncpg.Record]]:
        """Get paginated node shares for a user.

        Node metadata (name, icon, kind) is no longer joined from the legacy
        ``node`` table; callers enrich share rows from the operation-log derived
        state via :class:`app.core.workspace_store.WorkspaceStore`.
        """
        offset = (page - 1) * page_size
        async with acquire_connection(self._pool) as conn:
            total = await conn.fetchval(
                """
                SELECT COUNT(*) FROM node_share ns
                WHERE ns.user_id = $1 AND ns.active = TRUE
                """,
                user_id,
            )
            rows = await conn.fetch(
                """
                SELECT ns.id, ns.uuid as share_uuid, ns.node_uuid, ns.can_read, ns.can_write,
                       ns.create_date as shared_at, ns.create_uid as shared_by_id,
                       u.email as shared_by_email,
                       ns.workspace_id, w.name as workspace_name, w.uuid as workspace_uuid
                FROM node_share ns
                JOIN "user" u ON u.id = ns.create_uid
                JOIN workspace w ON w.id = ns.workspace_id
                WHERE ns.user_id = $1 AND ns.active = TRUE
                ORDER BY ns.create_date DESC
                LIMIT $2 OFFSET $3
                """,
                user_id,
                page_size,
                offset,
            )
        return total or 0, rows

    async def create_node_user_share(
        self,
        node_uuid: str,
        workspace_id: int,
        user_id: int,
        target_email: str,
        permission: str,
    ) -> dict[str, Any] | None:
        """Create or update a node-level user share or pending invite."""
        async with acquire_connection(self._pool) as conn, conn.transaction():
            # Resolve target user
            target = await conn.fetchrow(
                'SELECT id FROM "user" WHERE email = $1 AND active = TRUE',
                target_email,
            )

            if not target:
                # Target user does not exist — create a pending invite
                invite_uuid = str(uuid.uuid4())
                expires_at = datetime.now(UTC) + timedelta(days=7)
                await conn.execute(
                    """
                    INSERT INTO pending_invite (uuid, email, workspace_id, node_uuid, role, invited_by, expires_at, active)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
                    ON CONFLICT (email, workspace_id, node_uuid)
                    DO UPDATE SET
                        role = EXCLUDED.role,
                        invited_by = EXCLUDED.invited_by,
                        expires_at = EXCLUDED.expires_at,
                        active = TRUE,
                        created_at = NOW()
                    """,
                    invite_uuid,
                    target_email,
                    workspace_id,
                    node_uuid,
                    permission,
                    user_id,
                    expires_at,
                )

                return {
                    "status": "pending",
                    "email": target_email,
                    "invite_token": invite_uuid,
                    "node_uuid": node_uuid,
                }

            target_id = target["id"]
            if target_id == user_id:
                raise ValueError("Cannot share with yourself")

            can_write = permission == "write"

            row = await conn.fetchrow(
                """
                INSERT INTO node_share (node_uuid, user_id, can_read, can_write, can_create, can_delete,
                                        active, create_uid, write_uid)
                VALUES ($1, $2, TRUE, $3, $3, FALSE, TRUE, $4, $4)
                ON CONFLICT (node_uuid, user_id)
                DO UPDATE SET
                    can_read = TRUE,
                    can_write = EXCLUDED.can_write,
                    can_create = EXCLUDED.can_create,
                    active = TRUE,
                    write_uid = EXCLUDED.write_uid,
                    write_date = NOW()
                RETURNING id, uuid, node_uuid, user_id, can_read, can_write, create_date, create_uid,
                          (SELECT uuid FROM "user" WHERE id = node_share.user_id) as user_uuid,
                          (SELECT uuid FROM "user" WHERE id = node_share.create_uid) as create_user_uuid
                """,
                node_uuid,
                target_id,
                can_write,
                user_id,
            )

        return dict(row) if row else None

    async def list_node_user_shares(
        self, node_uuid: str, workspace_id: int, user_id: int
    ) -> list[asyncpg.Record]:
        """List active user shares for a node that involve the requesting user.

        A user may see shares they created or shares where they are the target.
        This avoids depending on the legacy ``node`` table or a server-side
        derived store that may lag the relay.
        """
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT ns.id, ns.uuid as share_uuid, ns.node_uuid, ns.user_id, u.email, ns.can_read, ns.can_write,
                       ns.create_date, ns.create_uid, u.uuid as shared_with_user_uuid,
                       (SELECT uuid FROM "user" WHERE id = ns.create_uid) as created_by_uuid
                FROM node_share ns
                JOIN "user" u ON u.id = ns.user_id
                WHERE ns.node_uuid = $1
                  AND ns.workspace_id = $2
                  AND ns.active = TRUE
                  AND (ns.create_uid = $3 OR ns.user_id = $3)
                ORDER BY ns.create_date DESC
                """,
                node_uuid,
                workspace_id,
                user_id,
            )
        return rows

    async def revoke_user_share(
        self, share_id: int, workspace_id: int, user_id: int
    ) -> dict[str, Any] | None:
        """Revoke a node user share."""
        async with acquire_connection(self._pool) as conn, conn.transaction():
            share_row = await conn.fetchrow(
                """
                SELECT node_uuid, create_uid
                FROM node_share
                WHERE id = $1 AND active = TRUE AND workspace_id = $2
                """,
                share_id,
                workspace_id,
            )
            if not share_row:
                return None
            if share_row["create_uid"] != user_id:
                raise PermissionError("Only the share creator can revoke")

            await conn.execute(
                "UPDATE node_share SET active = FALSE WHERE id = $1",
                share_id,
            )

        return {"node_uuid": str(share_row["node_uuid"])}

    async def get_node_user_share_by_uuid(
        self, share_uuid: str
    ) -> dict[str, Any] | None:
        """Get a node-level user share by its public UUID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT ns.id, ns.uuid as share_uuid, ns.node_uuid, ns.user_id, u.email,
                       ns.can_read, ns.can_write, ns.create_date, ns.create_uid
                FROM node_share ns
                JOIN "user" u ON u.id = ns.user_id
                WHERE ns.uuid = $1 AND ns.active = TRUE
                """,
                share_uuid,
            )
            return dict(row) if row else None

    async def revoke_user_share_by_uuid(
        self, share_uuid: str, workspace_id: int, user_id: int
    ) -> dict[str, Any] | None:
        """Revoke a node-level user share by its public UUID."""
        async with acquire_connection(self._pool) as conn, conn.transaction():
            share_row = await conn.fetchrow(
                """
                SELECT ns.id, ns.uuid as share_uuid, ns.node_uuid, ns.create_uid
                FROM node_share ns
                WHERE ns.uuid = $1 AND ns.active = TRUE AND ns.workspace_id = $2
                """,
                share_uuid,
                workspace_id,
            )
            if not share_row:
                return None
            if share_row["create_uid"] != user_id:
                raise PermissionError("Only the share creator can revoke")

            await conn.execute(
                "UPDATE node_share SET active = FALSE WHERE id = $1",
                share_row["id"],
            )

        return {
            "node_uuid": str(share_row["node_uuid"]),
            "share_uuid": str(share_row["share_uuid"]),
        }
