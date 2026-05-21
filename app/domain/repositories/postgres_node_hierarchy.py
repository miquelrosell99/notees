"""Mixin for hierarchy operations: move, breadcrumbs, ancestors, descendants.

This mixin is combined into PostgresNodeRepository to keep postgres_node.py
focused on pure CRUD.
"""
from __future__ import annotations

from typing import Optional, List

from ...db.connection import acquire_connection
from ...utils import utc_now
from .postgres_node_base import _PostgresNodeBase


class PostgresNodeHierarchyMixin(_PostgresNodeBase):
    """Hierarchy operations: move, breadcrumbs, ancestors, descendants."""

    async def move(
        self,
        node_id: int,
        new_parent_id: Optional[int] = None,
        new_sequence: Optional[int] = None,
        user_id: Optional[int] = None,
    ) -> Optional[object]:
        """Move a node to a new parent and/or position with proper sibling resequencing."""
        async with acquire_connection(self._pool) as conn:
            async with conn.transaction():
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
                        await conn.execute("""
                            UPDATE node SET sequence = sequence - 1
                            WHERE parent_id = $1 AND sequence > $2 AND sequence <= $3
                            AND id != $4 AND workspace_id = $5
                        """, effective_parent_id, old_sequence, effective_sequence, node_id, self._workspace_id)
                    else:
                        await conn.execute("""
                            UPDATE node SET sequence = sequence + 1
                            WHERE parent_id = $1 AND sequence >= $2 AND sequence < $3
                            AND id != $4 AND workspace_id = $5
                        """, effective_parent_id, effective_sequence, old_sequence, node_id, self._workspace_id)
                else:
                    if old_parent_id is not None:
                        await self._close_sequence_gap(conn, old_parent_id, old_sequence)
                    if effective_parent_id is not None:
                        await self._shift_siblings_for_insert(conn, effective_parent_id, effective_sequence)

                await conn.execute("""
                    UPDATE node
                    SET parent_id = $1, page_id = $2, sequence = $3,
                        write_date = $4, write_uid = $5, version = version + 1
                    WHERE id = $6 AND workspace_id = $7
                """, effective_parent_id, new_page_id, effective_sequence, now, uid, node_id, self._workspace_id)

                row = await conn.fetchrow(
                    "SELECT * FROM node WHERE id = $1 AND workspace_id = $2",
                    node_id, self._workspace_id
                )
                return self._row_to_node(row) if row else None

    async def get_breadcrumbs(
        self,
        exit_node_id: int,
        enter_node_id: Optional[int] = None,
    ) -> List[object]:
        """Get the breadcrumb path for a node using the closure table."""
        async with acquire_connection(self._pool) as conn:
            if enter_node_id is not None:
                rows = await conn.fetch(
                    """
                    SELECT n.*
                    FROM get_breadcrumbs($1, $2) AS bc
                    JOIN node n ON n.id = bc.id
                    WHERE n.workspace_id = $3
                    ORDER BY bc.depth DESC
                    """,
                    exit_node_id, enter_node_id, self._workspace_id,
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT n.*
                    FROM get_breadcrumbs($1) AS bc
                    JOIN node n ON n.id = bc.id
                    WHERE n.workspace_id = $2
                    ORDER BY bc.depth DESC
                    """,
                    exit_node_id, self._workspace_id,
                )
            return [self._row_to_node(row) for row in rows]

    async def get_ancestors(
        self,
        node_id: int,
        include_self: bool = False,
    ) -> List[int]:
        """Get all ancestor IDs of a node using the closure table."""
        async with acquire_connection(self._pool) as conn:
            if include_self:
                rows = await conn.fetch("""
                    SELECT np.ancestor_id
                    FROM node_path np
                    JOIN node n ON n.id = np.ancestor_id
                    WHERE np.descendant_id = $1 AND n.workspace_id = $2
                      AND n.active = TRUE AND n.is_deleted = FALSE
                    ORDER BY np.depth DESC
                """, node_id, self._workspace_id)
            else:
                rows = await conn.fetch("""
                    SELECT np.ancestor_id
                    FROM node_path np
                    JOIN node n ON n.id = np.ancestor_id
                    WHERE np.descendant_id = $1 AND np.depth > 0 AND n.workspace_id = $2
                      AND n.active = TRUE AND n.is_deleted = FALSE
                    ORDER BY np.depth DESC
                """, node_id, self._workspace_id)
            return [row['ancestor_id'] for row in rows]

    async def get_descendants(
        self,
        node_id: int,
        include_self: bool = False,
    ) -> List[int]:
        """Get all descendant IDs of a node using the closure table."""
        async with acquire_connection(self._pool) as conn:
            if include_self:
                rows = await conn.fetch("""
                    SELECT np.descendant_id
                    FROM node_path np
                    JOIN node n ON n.id = np.descendant_id
                    WHERE np.ancestor_id = $1 AND n.workspace_id = $2
                      AND n.active = TRUE AND n.is_deleted = FALSE
                """, node_id, self._workspace_id)
            else:
                rows = await conn.fetch("""
                    SELECT np.descendant_id
                    FROM node_path np
                    JOIN node n ON n.id = np.descendant_id
                    WHERE np.ancestor_id = $1 AND np.depth > 0 AND n.workspace_id = $2
                      AND n.active = TRUE AND n.is_deleted = FALSE
                """, node_id, self._workspace_id)
            return [row['descendant_id'] for row in rows]

    async def get_all_descendants(
        self,
        node_id: int,
        include_self: bool = False,
    ) -> List[int]:
        """Get all descendant IDs of a node using the closure table,
        regardless of soft-delete status. Used for restore operations."""
        async with acquire_connection(self._pool) as conn:
            if include_self:
                rows = await conn.fetch("""
                    SELECT np.descendant_id
                    FROM node_path np
                    WHERE np.ancestor_id = $1
                """, node_id)
            else:
                rows = await conn.fetch("""
                    SELECT np.descendant_id
                    FROM node_path np
                    WHERE np.ancestor_id = $1 AND np.depth > 0
                """, node_id)
            return [row['descendant_id'] for row in rows]
