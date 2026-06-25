"""PostgreSQL implementation of ClassExtendRepository."""

from __future__ import annotations

from typing import Any

from app.db.connection import acquire_connection
from app.domain.entities import ClassExtend
from app.domain.repositories.base import BasePostgresRepository
from app.features.nodes.port import ClassExtendRepository


class PostgresClassExtendRepository(BasePostgresRepository, ClassExtendRepository):
    """PostgreSQL implementation of class extension operations."""

    async def get_extended_classes(self, class_node_id: int) -> list[int]:
        """Get direct parent class IDs that this class extends, ordered by sequence."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT ce.source_id
                FROM class_extend ce
                JOIN node n ON n.id = ce.source_id
                WHERE ce.target_id = $1
                  AND n.workspace_id = $2
                  AND n.active = TRUE
                ORDER BY ce.sequence, ce.id
            """,
                class_node_id,
                self._workspace_id,
            )
            return [row["source_id"] for row in rows]

    async def get_extended_classes_with_details(self, class_node_id: int) -> list[ClassExtend]:
        """Get direct parent classes with full details (name, icon)."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT ce.id, ce.uuid, ce.target_id, ce.source_id, ce.sequence, n.name, n.icon
                FROM class_extend ce
                JOIN node n ON n.id = ce.source_id
                WHERE ce.target_id = $1
                  AND n.workspace_id = $2
                  AND n.active = TRUE
                ORDER BY ce.sequence, ce.id
            """,
                class_node_id,
                self._workspace_id,
            )
            return [
                ClassExtend(
                    id=row["id"],
                    uuid=str(row["uuid"]),
                    target_id=row["target_id"],
                    source_id=row["source_id"],
                    sequence=row["sequence"],
                    source_name=row["name"],
                    source_icon=row["icon"],
                )
                for row in rows
            ]

    async def add_extends(self, class_node_id: int, extends_class_id: int, sequence: int = 0) -> ClassExtend:
        """Add an extends relationship. Raises ValueError if already exists."""
        async with acquire_connection(self._pool) as conn:
            existing = await conn.fetchrow(
                """
                SELECT id FROM class_extend
                WHERE target_id = $1 AND source_id = $2
            """,
                class_node_id,
                extends_class_id,
            )
            if existing:
                raise ValueError(f"Class {class_node_id} already extends {extends_class_id}")

            source = await conn.fetchrow(
                "SELECT name, icon FROM node WHERE id = $1 AND workspace_id = $2", extends_class_id, self._workspace_id
            )
            if not source:
                raise ValueError(f"Class {extends_class_id} not found")

            row = await conn.fetchrow(
                """
                INSERT INTO class_extend (target_id, source_id, sequence)
                VALUES ($1, $2, $3)
                RETURNING id, uuid, target_id, source_id, sequence
            """,
                class_node_id,
                extends_class_id,
                sequence,
            )

            return ClassExtend(
                id=row["id"],
                uuid=str(row["uuid"]),
                target_id=row["target_id"],
                source_id=row["source_id"],
                sequence=row["sequence"],
                source_name=source["name"],
                source_icon=source["icon"],
            )

    async def get_class_extend_by_uuid(self, uuid: str) -> ClassExtend | None:
        """Get a class extension relationship by its public UUID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT ce.id, ce.uuid, ce.target_id, ce.source_id, ce.sequence, n.name, n.icon
                FROM class_extend ce
                JOIN node n ON n.id = ce.source_id
                WHERE ce.uuid = $1
                  AND n.workspace_id = $2
                  AND n.active = TRUE
            """,
                uuid,
                self._workspace_id,
            )
            if not row:
                return None
            return ClassExtend(
                id=row["id"],
                uuid=str(row["uuid"]),
                target_id=row["target_id"],
                source_id=row["source_id"],
                sequence=row["sequence"],
                source_name=row["name"],
                source_icon=row["icon"],
            )

    async def remove_extends(self, class_node_id: int, extends_class_id: int) -> bool:
        """Remove an extends relationship. Returns True if deleted."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                """
                DELETE FROM class_extend
                WHERE target_id = $1 AND source_id = $2
            """,
                class_node_id,
                extends_class_id,
            )
            return result == "DELETE 1"

    async def get_classes_extended_by(self, class_node_id: int) -> list[dict[str, Any]]:
        """Get all classes that directly extend this class (reverse lookup)."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT DISTINCT n.id, n.uuid, n.name, n.icon
                FROM node n
                JOIN class_extend ce ON ce.target_id = n.id
                WHERE ce.source_id = $1
                  AND n.workspace_id = $2
                  AND n.active = TRUE
                  AND n.is_class = TRUE
                ORDER BY n.name
            """,
                class_node_id,
                self._workspace_id,
            )
            return [
                {
                    "id": row["id"],
                    "uuid": str(row["uuid"]),
                    "name": row["name"],
                    "icon": row["icon"],
                }
                for row in rows
            ]

    async def get_direct_subclasses(self, class_node_id: int) -> list[int]:
        """Get direct subclass IDs (classes that extend this class)."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT DISTINCT n.id
                FROM node n
                JOIN class_extend ce ON ce.target_id = n.id
                WHERE ce.source_id = $1
                  AND n.workspace_id = $2
                  AND n.active = TRUE
                  AND n.is_class = TRUE
            """,
                class_node_id,
                self._workspace_id,
            )
            return [row["id"] for row in rows]

    async def get_extended_classes_batch(self, node_ids: list[int]) -> dict[int, list[int]]:
        """Batch-fetch class extends (parent class IDs) for a set of class nodes."""
        if not node_ids:
            return {}
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT ce.target_id, ce.source_id
                FROM class_extend ce
                JOIN node n ON n.id = ce.source_id
                WHERE ce.target_id = ANY($1)
                  AND n.workspace_id = $2
                  AND n.active = TRUE
                ORDER BY ce.target_id, ce.sequence, ce.id
            """,
                node_ids,
                self._workspace_id,
            )
            result: dict[int, list[int]] = {}
            for row in rows:
                result.setdefault(row["target_id"], []).append(row["source_id"])
            return result

    async def get_by_uuid(self, extend_uuid: str) -> ClassExtend | None:
        """Get a class extension relationship by its public UUID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT ce.id, ce.uuid, ce.target_id, ce.source_id, ce.sequence, n.name, n.icon
                FROM class_extend ce
                JOIN node n ON n.id = ce.source_id
                WHERE ce.uuid = $1
                  AND n.workspace_id = $2
                  AND n.active = TRUE
            """,
                extend_uuid,
                self._workspace_id,
            )
            if row is None:
                return None
            return ClassExtend(
                id=row["id"],
                uuid=str(row["uuid"]),
                target_id=row["target_id"],
                source_id=row["source_id"],
                sequence=row["sequence"],
                source_name=row["name"],
                source_icon=row["icon"],
            )

    async def get_uuids_by_ids(self, extend_ids: list[int]) -> dict[int, str]:
        """Return a mapping of internal class_extend IDs to public UUIDs."""
        if not extend_ids:
            return {}
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, uuid FROM class_extend
                WHERE id = ANY($1) AND workspace_id = $2
            """,
                extend_ids,
                self._workspace_id,
            )
            return {row["id"]: str(row["uuid"]) for row in rows}

    async def expand_class_hierarchy(self, class_ids: list[int]) -> set[int]:
        """Expand a set of class IDs to include all subclasses recursively."""
        if not class_ids:
            return set()
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                WITH RECURSIVE filter_hierarchy AS (
                    SELECT id FROM node WHERE id = ANY($1::int[]) AND workspace_id = $2
                    UNION
                    SELECT ce.target_id FROM class_extend ce
                    INNER JOIN filter_hierarchy fh ON ce.source_id = fh.id
                )
                SELECT id FROM filter_hierarchy
            """,
                class_ids,
                self._workspace_id,
            )
            return {row["id"] for row in rows}
