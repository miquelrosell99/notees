"""Mixin for hierarchy operations: move, breadcrumbs, ancestors, descendants.

This mixin is combined into PostgresNodeRepository to keep postgres_node.py
focused on pure CRUD.
"""

from __future__ import annotations

from ...db.connection import acquire_connection
from ...utils import utc_now
from .postgres_node_base import _PostgresNodeBase


class PostgresNodeHierarchyMixin(_PostgresNodeBase):
    """Hierarchy operations: move, breadcrumbs, ancestors, descendants."""

    async def move(
        self,
        node_id: int,
        new_parent_id: int | None = None,
        new_sequence: int | None = None,
        user_id: int | None = None,
    ) -> object | None:
        """Move a node to a new parent and/or position with proper sibling resequencing."""
        async with acquire_connection(self._pool) as conn, conn.transaction():
            node = await self.get_by_id(node_id)
            if not node:
                return None

            old_parent_id = node.parent_id
            old_sequence = node.sequence
            now = utc_now()
            uid = user_id or self._user_id

            effective_parent_id = new_parent_id if new_parent_id is not None else old_parent_id
            effective_sequence = new_sequence if new_sequence is not None else old_sequence

            # Pages never have page_id - only blocks do
            if node.is_page:
                new_page_id = None
            elif effective_parent_id is not None and await self._is_page(effective_parent_id):
                new_page_id = effective_parent_id
            else:
                new_page_id = await self._compute_page_id(effective_parent_id) if effective_parent_id else None

            if old_parent_id == effective_parent_id:
                if old_sequence == effective_sequence:
                    return node

                if old_sequence < effective_sequence:
                    await conn.execute(
                        """
                            UPDATE node SET sequence = sequence - 1
                            WHERE parent_id = $1 AND sequence > $2 AND sequence <= $3
                            AND id != $4 AND workspace_id = $5
                        """,
                        effective_parent_id,
                        old_sequence,
                        effective_sequence,
                        node_id,
                        self._workspace_id,
                    )
                else:
                    await conn.execute(
                        """
                            UPDATE node SET sequence = sequence + 1
                            WHERE parent_id = $1 AND sequence >= $2 AND sequence < $3
                            AND id != $4 AND workspace_id = $5
                        """,
                        effective_parent_id,
                        effective_sequence,
                        old_sequence,
                        node_id,
                        self._workspace_id,
                    )
            else:
                if old_parent_id is not None:
                    await self._close_sequence_gap(conn, old_parent_id, old_sequence)
                if effective_parent_id is not None:
                    await self._shift_siblings_for_insert(conn, effective_parent_id, effective_sequence)

            await conn.execute(
                """
                    UPDATE node
                    SET parent_id = $1, page_id = $2, sequence = $3,
                        write_date = $4, write_uid = $5, version = version + 1
                    WHERE id = $6 AND workspace_id = $7
                """,
                effective_parent_id,
                new_page_id,
                effective_sequence,
                now,
                uid,
                node_id,
                self._workspace_id,
            )

            row = await conn.fetchrow(
                "SELECT * FROM node WHERE id = $1 AND workspace_id = $2", node_id, self._workspace_id
            )
            return self._row_to_node(row) if row else None

    async def get_breadcrumbs(
        self,
        exit_node_id: int,
        enter_node_id: int | None = None,
    ) -> list[object]:
        """Get the breadcrumb path for a node using recursive CTE."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id, 0 AS depth
                    FROM node
                    WHERE id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE
                    UNION ALL
                    SELECT n.id, n.parent_id, a.depth + 1
                    FROM node n
                    INNER JOIN ancestors a ON n.id = a.parent_id
                    WHERE n.workspace_id = $2 AND n.active = TRUE AND n.is_deleted = FALSE
                )
                SELECT n.* FROM ancestors a
                JOIN node n ON n.id = a.id
                WHERE ($3::int IS NULL OR a.id != $3::int)
                ORDER BY a.depth DESC
                """,
                exit_node_id,
                self._workspace_id,
                enter_node_id,
            )
            return [self._row_to_node(row) for row in rows]

    async def get_ancestors(
        self,
        node_id: int,
        include_self: bool = False,
    ) -> list[int]:
        """Get all ancestor IDs of a node using recursive CTE."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id, 0 AS depth
                    FROM node
                    WHERE id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE
                    UNION ALL
                    SELECT n.id, n.parent_id, a.depth + 1
                    FROM node n
                    INNER JOIN ancestors a ON n.id = a.parent_id
                    WHERE n.workspace_id = $2 AND n.active = TRUE AND n.is_deleted = FALSE
                )
                SELECT id, depth FROM ancestors
                WHERE ($3::boolean OR depth > 0)
                ORDER BY depth DESC
                """,
                node_id,
                self._workspace_id,
                include_self,
            )
            return [row["id"] for row in rows]

    async def get_descendants(
        self,
        node_id: int,
        include_self: bool = False,
    ) -> list[int]:
        """Get all descendant IDs of a node using recursive CTE."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                WITH RECURSIVE descendants AS (
                    SELECT id, 0 AS depth
                    FROM node
                    WHERE id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE
                    UNION ALL
                    SELECT n.id, d.depth + 1
                    FROM node n
                    INNER JOIN descendants d ON n.parent_id = d.id
                    WHERE n.workspace_id = $2 AND n.active = TRUE AND n.is_deleted = FALSE
                )
                SELECT id FROM descendants
                WHERE ($3::boolean OR depth > 0)
                """,
                node_id,
                self._workspace_id,
                include_self,
            )
            return [row["id"] for row in rows]

    async def get_descendants_batch(
        self,
        node_ids: list[int],
        include_self: bool = False,
    ) -> dict[int, list[int]]:
        """Get all descendant IDs for multiple nodes in a single recursive CTE.

        Returns a mapping of root_node_id -> list of descendant IDs.
        """
        if not node_ids:
            return {}

        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                WITH RECURSIVE descendants AS (
                    SELECT id, id AS root_id, 0 AS depth
                    FROM node
                    WHERE id = ANY($1::int[]) AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE
                    UNION ALL
                    SELECT n.id, d.root_id, d.depth + 1
                    FROM node n
                    INNER JOIN descendants d ON n.parent_id = d.id
                    WHERE n.workspace_id = $2 AND n.active = TRUE AND n.is_deleted = FALSE
                )
                SELECT root_id, id FROM descendants
                WHERE ($3::boolean OR depth > 0)
                ORDER BY root_id, depth
                """,
                node_ids,
                self._workspace_id,
                include_self,
            )
            result: dict[int, list[int]] = {}
            for row in rows:
                root_id = row["root_id"]
                result.setdefault(root_id, []).append(row["id"])
            return result

    async def get_all_descendants(
        self,
        node_id: int,
        include_self: bool = False,
    ) -> list[int]:
        """Get all descendant IDs of a node using recursive CTE,
        regardless of soft-delete status. Used for restore operations."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                WITH RECURSIVE descendants AS (
                    SELECT id, 0 AS depth
                    FROM node
                    WHERE id = $1
                    UNION ALL
                    SELECT n.id, d.depth + 1
                    FROM node n
                    INNER JOIN descendants d ON n.parent_id = d.id
                )
                SELECT id FROM descendants
                WHERE ($2::boolean OR depth > 0)
                """,
                node_id,
                include_self,
            )
            return [row["id"] for row in rows]
