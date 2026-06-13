"""PostgreSQL implementation of ShareRepository."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg

from ...db.connection import acquire_connection
from ...utils.email import render_invite_email, send_email
from ..entities import Node
from ..entities.share import PublicShare
from .base import BasePostgresRepository, normalize_timestamp
from .interfaces import ShareRepository


class PostgresShareRepository(BasePostgresRepository, ShareRepository):
    """Handles public share link CRUD."""

    def __init__(self, pool: asyncpg.Pool, workspace_id: int, user_id: int | None = None):
        super().__init__(pool, workspace_id, user_id)

    @staticmethod
    def _row_to_share(row: asyncpg.Record) -> PublicShare:
        return PublicShare(
            id=row["id"],
            uuid=str(row["uuid"]),
            node_id=row["node_id"],
            workspace_id=row["workspace_id"],
            created_by=row["created_by"],
            created_at=row["created_at"].isoformat() if row["created_at"] else "",
            expiry_date=row["expiry_date"].isoformat() if row["expiry_date"] else None,
            password_hash=row.get("password_hash"),
            active=row["active"],
        )

    async def create_share(
        self,
        node_id: int,
        workspace_id: int,
        created_by: int,
        expiry_date: str | None = None,
    ) -> PublicShare:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO node_public_share (node_id, workspace_id, created_by, expiry_date)
                VALUES ($1, $2, $3, $4)
                RETURNING id, uuid, node_id, workspace_id, created_by, created_at, expiry_date, password_hash, active
                """,
                node_id,
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
                SELECT id, uuid, node_id, workspace_id, created_by, created_at, expiry_date, password_hash, active
                FROM node_public_share
                WHERE uuid = $1
                """,
                share_uuid,
            )
        if row is None:
            return None
        return self._row_to_share(row)

    async def list_shares_for_node(self, node_id: int) -> list[PublicShare]:
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, uuid, node_id, workspace_id, created_by, created_at, expiry_date, password_hash, active
                FROM node_public_share
                WHERE node_id = $1 AND active = TRUE
                ORDER BY created_at DESC
                """,
                node_id,
            )
        return [self._row_to_share(row) for row in rows]

    async def list_shares_for_workspace(self, workspace_id: int) -> list[PublicShare]:
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT s.id, s.uuid, s.node_id, s.workspace_id, s.created_by, s.created_at, s.expiry_date, s.password_hash, s.active,
                       n.name as node_name, n.uuid as node_uuid
                FROM node_public_share s
                JOIN node n ON n.id = s.node_id
                WHERE s.workspace_id = $1 AND s.active = TRUE
                ORDER BY s.created_at DESC
                """,
                workspace_id,
            )
        shares = []
        for row in rows:
            share = self._row_to_share(row)
            # Attach node name for display purposes via a private attr
            object.__setattr__(share, "_node_name", row["node_name"])
            object.__setattr__(share, "_node_uuid", str(row["node_uuid"]))
            shares.append(share)
        return shares

    async def delete_share(self, share_uuid: str) -> bool:
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "UPDATE node_public_share SET active = FALSE WHERE uuid = $1",
                share_uuid,
            )
        # asyncpg returns e.g. "UPDATE 1"
        return result.split()[-1] != "0"

    @staticmethod
    def _row_to_node(row: asyncpg.Record) -> Node:
        classes_path = row.get("classes_path", [])
        if classes_path is None:
            classes_path = []
        elif isinstance(classes_path, str):
            try:
                classes_path = json.loads(classes_path)
            except (json.JSONDecodeError, TypeError):
                classes_path = []
        class_ids = row.get("class_ids", [])
        if class_ids is None:
            class_ids = []
        return Node(
            id=row["id"],
            uuid=str(row["uuid"]),
            workspace_id=row.get("workspace_id"),
            name=row["name"],
            icon=row.get("icon"),
            color=row.get("color"),
            parent_id=row.get("parent_id"),
            page_id=row.get("page_id"),
            sequence=row.get("sequence", 0),
            collapsed=row.get("collapsed", False),
            active=row.get("active", True),
            is_shared=row.get("is_shared", False),
            is_deleted=row.get("is_deleted", False),
            deleted_at=normalize_timestamp(row.get("deleted_at")) or None,
            is_class=row.get("is_class", False),
            is_page=row.get("is_page", False),
            is_day=row.get("is_day", False),
            is_month=row.get("is_month", False),
            is_year=row.get("is_year", False),
            is_asset=row.get("is_asset", False),
            is_template=row.get("is_template", False),
            is_comment=row.get("is_comment", False),
            parent_locked=row.get("parent_locked", False),
            open_date=normalize_timestamp(row.get("open_date")) or None,
            create_date=normalize_timestamp(row.get("create_date", "")),
            write_date=normalize_timestamp(row.get("write_date", "")),
            create_uid=row.get("create_uid"),
            write_uid=row.get("write_uid"),
            class_ids=class_ids,
            classes_path=classes_path,
            version=row.get("version", 1),
            aliased_id=row.get("aliased_id"),
        )

    async def get_shared_node(self, share_uuid: str) -> Node | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT n.*
                FROM node_public_share s
                JOIN node n ON n.id = s.node_id
                WHERE s.uuid = $1 AND s.active = TRUE
                  AND (s.expiry_date IS NULL OR s.expiry_date > NOW())
                  AND n.active = TRUE AND n.is_deleted = FALSE
                """,
                share_uuid,
            )
        if row is None:
            return None
        return self._row_to_node(row)

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
        """Get paginated node shares for a user."""
        offset = (page - 1) * page_size
        async with acquire_connection(self._pool) as conn:
            total = await conn.fetchval(
                """
                SELECT COUNT(*) FROM node_share ns
                JOIN node n ON n.id = ns.node_id
                WHERE ns.user_id = $1 AND ns.active = TRUE
                  AND n.active = TRUE AND n.is_deleted = FALSE
                """,
                user_id,
            )
            rows = await conn.fetch(
                """
                SELECT ns.id, ns.node_id, ns.can_read, ns.can_write,
                       ns.create_date as shared_at, ns.create_uid as shared_by_id,
                       u.email as shared_by_email,
                       n.uuid as node_uuid, n.name as node_name, n.icon as node_icon,
                       n.is_page, n.workspace_id, w.name as workspace_name, w.uuid as workspace_uuid
                FROM node_share ns
                JOIN node n ON n.id = ns.node_id
                JOIN "user" u ON u.id = ns.create_uid
                JOIN workspace w ON w.id = n.workspace_id
                WHERE ns.user_id = $1 AND ns.active = TRUE
                  AND n.active = TRUE AND n.is_deleted = FALSE
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
        node_id: int,
        workspace_id: int,
        user_id: int,
        target_email: str,
        permission: str,
    ) -> dict[str, Any] | None:
        """Create or update a node-level user share or pending invite."""
        async with acquire_connection(self._pool) as conn, conn.transaction():
            # Verify node exists in workspace
            node_row = await conn.fetchrow(
                "SELECT id FROM node WHERE id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
                node_id,
                workspace_id,
            )
            if not node_row:
                raise ValueError("Node not found")

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
                    INSERT INTO pending_invite (uuid, email, workspace_id, node_id, role, invited_by, expires_at, active)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
                    ON CONFLICT (email, workspace_id, node_id)
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
                    node_id,
                    permission,
                    user_id,
                    expires_at,
                )

                from ...config import settings

                invite_link = f"{settings.public_url}/enroll?token={invite_uuid}"
                node_name_row = await conn.fetchrow("SELECT name FROM node WHERE id = $1", node_id)
                node_name = node_name_row["name"] if node_name_row else None
                html, plain = render_invite_email(
                    inviter_name="",
                    workspace_name=None,
                    invite_link=invite_link,
                    node_name=node_name,
                )
                sent = await send_email(target_email, "Invitation to collaborate on Notees", html, plain)

                return {
                    "status": "pending",
                    "email": target_email,
                    "invite_link": None if sent else invite_link,
                }

            target_id = target["id"]
            if target_id == user_id:
                raise ValueError("Cannot share with yourself")

            can_write = permission == "write"

            row = await conn.fetchrow(
                """
                INSERT INTO node_share (node_id, user_id, can_read, can_write, can_create, can_delete,
                                        active, create_uid, write_uid)
                VALUES ($1, $2, TRUE, $3, $3, FALSE, TRUE, $4, $4)
                ON CONFLICT (node_id, user_id)
                DO UPDATE SET
                    can_read = TRUE,
                    can_write = EXCLUDED.can_write,
                    can_create = EXCLUDED.can_create,
                    active = TRUE,
                    write_uid = EXCLUDED.write_uid,
                    write_date = NOW()
                RETURNING id, node_id, user_id, can_read, can_write, create_date, create_uid
                """,
                node_id,
                target_id,
                can_write,
                user_id,
            )

            # Mark node as shared
            await conn.execute(
                "UPDATE node SET is_shared = TRUE WHERE id = $1",
                node_id,
            )

        return dict(row) if row else None

    async def list_node_user_shares(
        self, node_id: int, workspace_id: int, user_id: int
    ) -> tuple[bool, list[asyncpg.Record]]:
        """List user shares for a node. Returns (is_owner, rows)."""
        async with acquire_connection(self._pool) as conn:
            node_row = await conn.fetchrow(
                "SELECT create_uid FROM node WHERE id = $1 AND workspace_id = $2 AND active = TRUE",
                node_id,
                workspace_id,
            )
            if not node_row:
                raise ValueError("Node not found")
            if node_row["create_uid"] != user_id:
                raise PermissionError("Only node owners can view shares")

            rows = await conn.fetch(
                """
                SELECT ns.id, ns.node_id, ns.user_id, u.email, ns.can_read, ns.can_write,
                       ns.create_date, ns.create_uid
                FROM node_share ns
                JOIN "user" u ON u.id = ns.user_id
                WHERE ns.node_id = $1 AND ns.active = TRUE
                ORDER BY ns.create_date DESC
                """,
                node_id,
            )
        return True, rows

    async def revoke_user_share(
        self, share_id: int, workspace_id: int, user_id: int
    ) -> dict[str, Any] | None:
        """Revoke a node user share and clear is_shared if no shares remain."""
        async with acquire_connection(self._pool) as conn, conn.transaction():
            # Verify the share exists and user is the creator or node owner
            share_row = await conn.fetchrow(
                """
                SELECT ns.node_id, ns.create_uid, n.create_uid as node_owner_id
                FROM node_share ns
                JOIN node n ON n.id = ns.node_id
                WHERE ns.id = $1 AND ns.active = TRUE AND n.workspace_id = $2
                """,
                share_id,
                workspace_id,
            )
            if not share_row:
                return None
            if share_row["create_uid"] != user_id and share_row["node_owner_id"] != user_id:
                raise PermissionError("Only the share creator or node owner can revoke")

            await conn.execute(
                "UPDATE node_share SET active = FALSE WHERE id = $1",
                share_id,
            )

            # Check if any shares remain; if not, clear is_shared flag
            remaining = await conn.fetchrow(
                "SELECT 1 FROM node_share WHERE node_id = $1 AND active = TRUE LIMIT 1",
                share_row["node_id"],
            )
            public_remaining = await conn.fetchrow(
                "SELECT 1 FROM node_public_share WHERE node_id = $1 AND active = TRUE LIMIT 1",
                share_row["node_id"],
            )
            if not remaining and not public_remaining:
                await conn.execute(
                    "UPDATE node SET is_shared = FALSE WHERE id = $1",
                    share_row["node_id"],
                )

        return {"node_id": share_row["node_id"]}
