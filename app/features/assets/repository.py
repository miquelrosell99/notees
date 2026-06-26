"""PostgreSQL implementation of AssetRepository."""

from __future__ import annotations

from typing import Any

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
        asset_file_id: int | None = None,
    ) -> None:
        """Update an existing node so it becomes an asset node."""
        now = utc_now()
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                UPDATE node
                SET name = $1, uuid = $2, is_asset = TRUE,
                    asset_file_id = $3, write_date = $4, write_uid = $5
                WHERE id = $6 AND workspace_id = $7
                """,
                name,
                asset_uuid,
                asset_file_id,
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

    async def create_asset_file(
        self,
        hash: str,
        size_bytes: int,
        extension: str,
        storage_path: str,
        user_id: int,
    ) -> int:
        """Create an asset_file record and return its internal id."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO asset_file (
                    workspace_id, hash, size_bytes, extension, storage_path, ref_count, create_date
                )
                VALUES ($1, $2, $3, $4, $5, 1, NOW())
                RETURNING id
                """,
                self._workspace_id,
                hash,
                size_bytes,
                extension,
                storage_path,
            )
            if row is None:
                raise RuntimeError("Failed to create asset_file record")
            return row["id"]

    async def find_asset_file_by_hash(self, hash: str) -> dict[str, Any] | None:
        """Return an existing asset_file row for the given hash in the workspace."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT id, uuid, hash, size_bytes, extension, storage_path, ref_count
                FROM asset_file
                WHERE workspace_id = $1 AND hash = $2
                """,
                self._workspace_id,
                hash,
            )
            return dict(row) if row else None

    async def get_asset_file_by_id(self, asset_file_id: int) -> dict[str, Any] | None:
        """Return an asset_file row by internal id."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT id, uuid, hash, size_bytes, extension, storage_path, ref_count
                FROM asset_file
                WHERE id = $1 AND workspace_id = $2
                """,
                asset_file_id,
                self._workspace_id,
            )
            return dict(row) if row else None

    async def increment_asset_file_ref_count(self, asset_file_id: int) -> None:
        """Increment the ref_count of an asset_file."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                UPDATE asset_file
                SET ref_count = ref_count + 1
                WHERE id = $1 AND workspace_id = $2
                """,
                asset_file_id,
                self._workspace_id,
            )

    async def decrement_asset_file_ref_count(self, asset_file_id: int) -> int:
        """Decrement the ref_count and return the new value."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                UPDATE asset_file
                SET ref_count = ref_count - 1
                WHERE id = $1 AND workspace_id = $2
                RETURNING ref_count
                """,
                asset_file_id,
                self._workspace_id,
            )
            return row["ref_count"] if row else 0
