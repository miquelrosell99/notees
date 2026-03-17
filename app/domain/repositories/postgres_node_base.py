"""Shared base class for PostgreSQL Node repository implementations.

Contains the constructor, row conversion, and low-level helpers used by
PostgresNodeRepository, PostgresNodeHierarchyMixin, and
PostgresNodeSearchMixin.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional, Union, TYPE_CHECKING

import asyncpg
from asyncpg import Connection
from asyncpg.pool import PoolConnectionProxy

from ..entities import Node, generate_uuid
from ..permissions import PermissionChecker
from ...db.connection import acquire_connection

if TYPE_CHECKING:
    pass

ConnectionType = Union[Connection, PoolConnectionProxy]

from ..stringify_ast import parse_ast, serialize_ast, ParseMode


def _normalize_name_to_ast(name: Optional[str]) -> Optional[str]:
    """Normalize a name to AST format. Plain text is parsed for inline
    Markdown and converted to AST JSON."""
    if name is None or name == "":
        return name
    ast = parse_ast(name, ParseMode.JSON)
    if ast:
        return name
    return serialize_ast(parse_ast(name, ParseMode.MARKDOWN))


class _PostgresNodeBase:
    """Shared state and low-level helpers for all Postgres node repositories.

    Not intended for direct instantiation — use PostgresNodeRepository.
    """

    def __init__(
        self,
        pool: asyncpg.Pool,
        workspace_id: int,
        page_type_id: int,
        user_id: Optional[int] = None,
    ):
        self._pool = pool
        self._workspace_id = workspace_id
        self._page_class_id = page_type_id
        self._user_id = user_id
        self._permissions: Optional[PermissionChecker] = None

    @property
    def permissions(self) -> PermissionChecker:
        if self._permissions is None and self._user_id is not None:
            self._permissions = PermissionChecker(self._pool, self._user_id)
        elif self._permissions is None:
            raise RuntimeError("User ID required for permission checks")
        return self._permissions

    def get_connection(self) -> asyncpg.Pool:
        """Return the underlying connection pool."""
        return self._pool

    def row_to_node(self, row: asyncpg.Record) -> Node:
        """Convert a database row to a Node entity (public interface)."""
        return self._row_to_node(row)

    def _row_to_node(self, row: asyncpg.Record) -> Node:
        """Convert database row to Node entity."""
        classes_path = row.get('classes_path', [])
        if classes_path is None:
            classes_path = []
        elif isinstance(classes_path, str):
            try:
                classes_path = json.loads(classes_path)
            except (json.JSONDecodeError, TypeError):
                classes_path = []

        class_ids = row.get('class_ids', [])
        if class_ids is None:
            class_ids = []

        create_date = row['create_date']
        write_date = row['write_date']
        open_date = row.get('open_date')
        deleted_at = row.get('deleted_at')

        if isinstance(create_date, datetime):
            create_date = create_date.isoformat()
        if isinstance(write_date, datetime):
            write_date = write_date.isoformat()
        if isinstance(open_date, datetime):
            open_date = open_date.isoformat()
        if isinstance(deleted_at, datetime):
            deleted_at = deleted_at.isoformat()

        return Node(
            id=row['id'],
            uuid=str(row['uuid']),
            workspace_id=row.get('workspace_id'),
            name=row['name'],
            icon=row.get('icon'),
            color=row.get('color'),
            parent_id=row.get('parent_id'),
            page_id=row.get('page_id'),
            sequence=row.get('sequence', 0),
            collapsed=row.get('collapsed', False),
            active=row.get('active', True),
            is_shared=row.get('is_shared', False),
            is_deleted=row.get('is_deleted', False),
            deleted_at=deleted_at,
            is_class=row.get('is_class', False),
            is_page=row.get('is_page', False),
            is_day=row.get('is_day', False),
            is_month=row.get('is_month', False),
            is_year=row.get('is_year', False),
            is_asset=row.get('is_asset', False),
            is_template=row.get('is_template', False),
            is_comment=row.get('is_comment', False),
            open_date=open_date,
            create_date=create_date,
            write_date=write_date,
            create_uid=row.get('create_uid'),
            write_uid=row.get('write_uid'),
            class_ids=class_ids,
            classes_path=classes_path,
            version=row.get('version', 1),
            aliased_id=row.get('aliased_id'),
        )

    async def _compute_page_id(self, parent_id: int) -> Optional[int]:
        """Walk up parent chain to find containing page using closure table."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow("""
                SELECT n.id
                FROM node_path np
                JOIN node n ON n.id = np.ancestor_id
                WHERE np.descendant_id = $1
                  AND n.is_page = TRUE
                  AND n.workspace_id = $2
                  AND n.active = TRUE
                ORDER BY np.depth ASC
                LIMIT 1
            """, parent_id, self._workspace_id)
            return row['id'] if row else None

    async def _is_page(self, node_id: int) -> bool:
        """Check if a node is a page."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT is_page FROM node WHERE id = $1 AND workspace_id = $2",
                node_id, self._workspace_id,
            )
            return row['is_page'] if row else False

    async def _shift_siblings_for_insert(
        self, conn: ConnectionType, parent_id: int, sequence: int
    ) -> None:
        """Shift siblings at or after the given sequence to make room."""
        await conn.execute("""
            UPDATE node SET sequence = sequence + 1
            WHERE parent_id = $1 AND sequence >= $2 AND workspace_id = $3
        """, parent_id, sequence, self._workspace_id)

    async def _close_sequence_gap(
        self, conn: ConnectionType, parent_id: int, old_sequence: int
    ) -> None:
        """Close the gap left by a node that moved away."""
        await conn.execute("""
            UPDATE node SET sequence = sequence - 1
            WHERE parent_id = $1 AND sequence > $2 AND workspace_id = $3
        """, parent_id, old_sequence, self._workspace_id)
