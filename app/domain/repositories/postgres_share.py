"""PostgreSQL implementation of ShareRepository."""

from __future__ import annotations

import json

import asyncpg

from ...db.connection import acquire_connection
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
