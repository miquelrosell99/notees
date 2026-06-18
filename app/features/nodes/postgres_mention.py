"""PostgreSQL implementation of MentionRepository."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import asyncpg

from app.db.connection import acquire_connection
from app.domain.entities import NodeMention
from app.domain.repositories.base import BasePostgresRepository, normalize_timestamp
from app.features.nodes.port import MentionRepository


class PostgresMentionRepository(BasePostgresRepository, MentionRepository):
    """PostgreSQL implementation of the MentionRepository port."""

    def _row_to_mention(self, row: asyncpg.Record) -> NodeMention:
        create_date = normalize_timestamp(row["create_date"])
        write_date = normalize_timestamp(row["write_date"])
        return NodeMention(
            id=row["id"],
            uuid=str(row["uuid"]) if row.get("uuid") else None,
            source_id=row["source_id"],
            target_id=row["target_id"],
            workspace_id=row["workspace_id"],
            match_text=row["match_text"],
            position=row.get("position", 0),
            is_ignored=row.get("is_ignored", False),
            create_date=create_date,
            write_date=write_date,
            create_uid=row.get("create_uid"),
            write_uid=row.get("write_uid"),
        )

    async def delete_for_source(self, source_node_id: int) -> int:
        """Delete all mentions for a source node."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_mention WHERE source_id = $1 AND workspace_id = $2",
                source_node_id,
                self._workspace_id,
            )
            return int(result.split()[-1]) if result else 0

    async def create(self, mention: NodeMention) -> NodeMention:
        """Create a mention candidate."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO node_mention
                    (uuid, source_id, target_id, workspace_id, match_text, position, is_ignored, create_date, write_date, create_uid, write_uid)
                VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $8, $9, $9)
                RETURNING id, uuid
            """,
                mention.uuid,
                mention.source_id,
                mention.target_id,
                self._workspace_id,
                mention.match_text,
                mention.position,
                mention.is_ignored,
                mention.create_date,
                mention.create_uid or self._user_id,
            )
            if row is None:
                raise RuntimeError("Failed to create mention - no row returned")
            mention.id = row["id"]
            mention.uuid = str(row["uuid"])
            return mention

    async def create_many(self, mentions: list[NodeMention]) -> None:
        """Create multiple mentions via COPY for efficiency."""
        if not mentions:
            return

        async with acquire_connection(self._pool) as conn:
            now = datetime.now(UTC)
            records = [
                (
                    m.source_id,
                    m.target_id,
                    self._workspace_id,
                    m.match_text,
                    m.position,
                    m.is_ignored,
                    now,
                    m.create_uid or self._user_id,
                )
                for m in mentions
            ]
            await conn.copy_records_to_table(
                "node_mention",
                records=records,
                columns=[
                    "source_id",
                    "target_id",
                    "workspace_id",
                    "match_text",
                    "position",
                    "is_ignored",
                    "create_date",
                    "create_uid",
                ],
            )

    async def list_for_target(
        self,
        target_node_id: int,
        include_ignored: bool = False,
    ) -> list[NodeMention]:
        """List mentions for a target node."""
        async with acquire_connection(self._pool) as conn:
            if include_ignored:
                rows = await conn.fetch(
                    """
                    SELECT * FROM node_mention
                    WHERE target_id = $1 AND workspace_id = $2
                    ORDER BY position
                """,
                    target_node_id,
                    self._workspace_id,
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT * FROM node_mention
                    WHERE target_id = $1 AND workspace_id = $2 AND is_ignored = FALSE
                    ORDER BY position
                """,
                    target_node_id,
                    self._workspace_id,
                )
            return [self._row_to_mention(row) for row in rows]

    async def list_for_target_with_source_info(
        self,
        target_node_id: int,
        include_ignored: bool = False,
    ) -> list[dict[str, Any]]:
        """List mentions with source node name/uuid."""
        async with acquire_connection(self._pool) as conn:
            if include_ignored:
                rows = await conn.fetch(
                    """
                    SELECT m.*, n.name as source_name, n.uuid as source_uuid, n.is_page as source_is_page
                    FROM node_mention m
                    JOIN node n ON m.source_id = n.id
                    WHERE m.target_id = $1 AND m.workspace_id = $2
                    ORDER BY m.position
                """,
                    target_node_id,
                    self._workspace_id,
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT m.*, n.name as source_name, n.uuid as source_uuid, n.is_page as source_is_page
                    FROM node_mention m
                    JOIN node n ON m.source_id = n.id
                    WHERE m.target_id = $1 AND m.workspace_id = $2 AND m.is_ignored = FALSE
                    ORDER BY m.position
                """,
                    target_node_id,
                    self._workspace_id,
                )
            return [dict(row) for row in rows]

    async def get_by_id(self, mention_id: int) -> NodeMention | None:
        """Get a mention by ID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT * FROM node_mention WHERE id = $1 AND workspace_id = $2",
                mention_id,
                self._workspace_id,
            )
            if not row:
                return None
            return self._row_to_mention(row)

    async def set_ignored(self, mention_id: int, ignored: bool = True) -> NodeMention | None:
        """Mark a mention as ignored (or un-ignored)."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                UPDATE node_mention
                SET is_ignored = $1, write_date = NOW(), write_uid = $2
                WHERE id = $3 AND workspace_id = $4
                RETURNING *
            """,
                ignored,
                self._user_id,
                mention_id,
                self._workspace_id,
            )
            if not row:
                return None
            return self._row_to_mention(row)

    async def delete_for_workspace(self) -> int:
        """Delete all mentions in the workspace."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_mention WHERE workspace_id = $1",
                self._workspace_id,
            )
            return int(result.split()[-1]) if result else 0
