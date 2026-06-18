"""PostgreSQL implementation of AssetRepository."""

from __future__ import annotations

import asyncpg

from app.db.connection import acquire_connection
from app.domain.repositories.base import BasePostgresRepository
from app.features.assets.port import AssetRepository
from app.utils import utc_now

from ...domain.entities import generate_uuid
from ...domain.stringify_ast import ParseMode, parse_ast, serialize_ast


class PostgresAssetRepository(BasePostgresRepository, AssetRepository):
    """PostgreSQL adapter for asset-specific persistence operations."""

    async def get_page_and_asset_class_ids(self, user_id: int) -> tuple[int, int]:
        """Return (page_class_id, asset_class_id), creating the asset class if needed."""
        from app.db.schema import SYSTEM_CLASS_UUIDS

        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2",
                SYSTEM_CLASS_UUIDS["page"],
                self._workspace_id,
            )
            page_class_id = row["id"] if row else 1

            row = await conn.fetchrow(
                "SELECT id FROM node WHERE uuid = $1 AND is_class = TRUE AND workspace_id = $2",
                SYSTEM_CLASS_UUIDS["asset"],
                self._workspace_id,
            )
            if row:
                asset_class_id = row["id"]
            else:
                asset_class_id = await self._create_asset_class(conn, user_id)

        return page_class_id, asset_class_id

    async def _create_asset_class(self, conn: asyncpg.Connection, user_id: int) -> int:
        """Create the system asset class and assign it the 'class' class."""
        from app.db.schema import SYSTEM_CLASS_UUIDS

        now = utc_now()
        asset_uuid = generate_uuid()
        asset_class_id = await conn.fetchval(
            """
            INSERT INTO node (
                workspace_id, uuid, name, icon, is_class, is_asset,
                create_date, write_date, create_uid, write_uid
            )
            VALUES ($1, $2, $3, NULL, TRUE, TRUE, $4, $4, $5, $5)
            RETURNING id
            """,
            self._workspace_id,
            asset_uuid,
            serialize_ast(parse_ast("asset", ParseMode.PLAIN)),
            now,
            user_id,
        )

        class_row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2",
            SYSTEM_CLASS_UUIDS["class"],
            self._workspace_id,
        )
        if class_row:
            await conn.execute(
                """
                UPDATE node
                SET class_ids = ARRAY[$1]::integer[], write_date = $2
                WHERE id = $3
                """,
                class_row["id"],
                now,
                asset_class_id,
            )

        return asset_class_id

    async def convert_node_to_asset(
        self,
        node_id: int,
        asset_uuid: str,
        name: str,
        asset_class_id: int,
        user_id: int,
    ) -> None:
        """Update an existing node so it becomes an asset node."""
        now = utc_now()
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                UPDATE node
                SET name = $1, uuid = $2, is_asset = TRUE,
                    write_date = $3, write_uid = $4
                WHERE id = $5 AND workspace_id = $6
                """,
                name,
                asset_uuid,
                now,
                user_id,
                node_id,
                self._workspace_id,
            )
            await conn.execute(
                """
                UPDATE node
                SET class_ids = class_ids || $1::integer[], write_date = $2
                WHERE id = $3
                """,
                [asset_class_id],
                now,
                node_id,
            )

    async def asset_exists_by_uuid(self, uuid: str) -> bool:
        """Return True if an asset node with the given UUID exists in the workspace."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT 1 FROM node
                WHERE uuid = $1 AND workspace_id = $2 AND is_asset = TRUE
                """,
                uuid,
                self._workspace_id,
            )
            return row is not None
