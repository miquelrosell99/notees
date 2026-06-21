"""PostgreSQL implementation of Node repository  pure CRUD.

Hierarchy operations (move, breadcrumbs, ancestors, descendants) live in
postgres_node_hierarchy.py.  Search/listing operations live in
postgres_node_search.py.  Shared utilities live in postgres_node_base.py.
"""

from __future__ import annotations

import re
from typing import Any

import asyncpg

from app.db.connection import acquire_connection
from app.domain.entities import Node, NodeCreateData, NodeUpdateData, generate_uuid
from app.domain.node_flags import compute_node_flags
from app.domain.stringify_ast import NodeLinkResolution, StringifyMode, StringifyOptions, parse_ast, stringify_ast
from app.features.nodes.port import NodeRepository
from app.features.nodes.postgres_node_base import _normalize_name_to_ast
from app.features.nodes.postgres_node_hierarchy import PostgresNodeHierarchyMixin
from app.features.nodes.postgres_node_search import PostgresNodeSearchMixin
from app.utils import utc_now

_NODE_SELECT_COLUMNS = (
    "id, uuid, workspace_id, name, icon, color, parent_id, page_id, sequence, collapsed, active, "
    "is_shared, is_page, is_class, is_day, is_month, is_year, is_asset, is_template, is_comment, is_task, is_table, is_card, is_cloze, "
    "parent_locked, is_private, is_deleted, deleted_at, class_ids, tag_ids, classes_path, "
    "create_date, write_date, open_date, create_uid, write_uid, version, aliased_id"
)


class PostgresNodeRepository(
    PostgresNodeHierarchyMixin,
    PostgresNodeSearchMixin,
    NodeRepository,
):
    """PostgreSQL implementation  CRUD operations only.

    Hierarchy operations are provided by PostgresNodeHierarchyMixin.
    Search/listing operations are provided by PostgresNodeSearchMixin.
    Both mixins share the _PostgresNodeBase constructor and helpers.
    """

    async def create(
        self,
        data: NodeCreateData,
        user_id: int | None = None,
        uuid: str | None = None,
    ) -> Node:
        """Create a new node."""
        now = utc_now()
        uuid = uuid or data.uuid or generate_uuid()
        uid = user_id or self._user_id

        normalized_name = _normalize_name_to_ast(data.name)

        page_id = None
        if data.parent_id:
            if await self._is_page(data.parent_id):
                page_id = data.parent_id
            else:
                page_id = await self._compute_page_id(data.parent_id)

        class_nodes = await self.get_by_ids(data.classes) if data.classes else []
        flags = compute_node_flags(class_nodes)

        is_class = flags.get("is_class", False)
        is_page = flags.get("is_page", False)
        is_day = flags.get("is_day", False)
        is_month = flags.get("is_month", False)
        is_year = flags.get("is_year", False)
        is_asset = flags.get("is_asset", False)
        is_template = flags.get("is_template", False)
        is_comment = flags.get("is_comment", False)
        is_task = flags.get("is_task", False)
        is_table = flags.get("is_table", False)
        is_card = flags.get("is_card", False)
        is_cloze = flags.get("is_cloze", False)

        # Pages never have page_id - only blocks do
        if is_page:
            page_id = None

        async with acquire_connection(self._pool) as conn, conn.transaction():
            row = await conn.fetchrow(
                """
                INSERT INTO node (
                    uuid, workspace_id, name, icon, color, parent_id, page_id,
                    sequence, collapsed,
                    is_class, is_page, is_day, is_month, is_year,
                    is_asset, is_template, is_comment, is_task, is_table, is_card, is_cloze,
                    class_ids, tag_ids,
                    create_date, write_date, create_uid, write_uid
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $24, $25, $25)
                RETURNING id
                """,
                uuid,
                self._workspace_id,
                normalized_name,
                data.icon,
                data.color,
                data.parent_id,
                page_id,
                data.sequence,
                data.collapsed,
                is_class,
                is_page,
                is_day,
                is_month,
                is_year,
                is_asset,
                is_template,
                is_comment,
                is_task,
                is_table,
                is_card,
                is_cloze,
                data.classes if data.classes else [],
                data.tags if data.tags else [],
                now,
                uid,
            )

            if row is None:
                raise RuntimeError("Failed to create node")
            node_id = row["id"]

        return Node(
            id=node_id,
            uuid=uuid,
            workspace_id=self._workspace_id,
            name=normalized_name,
            icon=data.icon,
            color=data.color,
            parent_id=data.parent_id,
            page_id=page_id,
            sequence=data.sequence,
            collapsed=data.collapsed,
            active=True,
            is_class=is_class,
            is_page=is_page,
            is_day=is_day,
            is_month=is_month,
            is_year=is_year,
            is_asset=is_asset,
            class_ids=data.classes if data.classes else [],
            tag_ids=data.tags if data.tags else [],
            is_template=is_template,
            is_comment=is_comment,
            is_task=is_task,
            is_table=is_table,
            is_card=is_card,
            is_cloze=is_cloze,
            create_date=now.isoformat(),
            write_date=now.isoformat(),
            create_uid=uid,
            write_uid=uid,
            version=1,
        )

    async def get_by_id(self, node_id: int) -> Node | None:
        """Get node by internal ID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                f"SELECT {_NODE_SELECT_COLUMNS} FROM node WHERE id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
                node_id,
                self._workspace_id,
            )
            if not row:
                return None

            if self._user_id and not await self.permissions.can_read_node(node_id):
                return None

            return self._row_to_node(row)

    async def get_by_ids(self, node_ids: list[int]) -> list[Node]:
        """Get multiple nodes by internal IDs in a single query."""
        if not node_ids:
            return []

        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                f"SELECT {_NODE_SELECT_COLUMNS} FROM node WHERE id = ANY($1) AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
                node_ids,
                self._workspace_id,
            )
            return [self._row_to_node(row) for row in rows]

    async def get_by_uuid(self, uuid: str) -> Node | None:
        """Get node by UUID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                f"SELECT {_NODE_SELECT_COLUMNS} FROM node WHERE uuid = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
                uuid,
                self._workspace_id,
            )
            if not row:
                return None

            if self._user_id and not await self.permissions.can_read_node(row["id"]):
                return None

            return self._row_to_node(row)

    async def get_by_uuids(self, uuids: list) -> list:
        """Get multiple nodes by UUID in a single query."""
        if not uuids:
            return []
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                f"SELECT {_NODE_SELECT_COLUMNS} FROM node WHERE uuid = ANY($1) AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
                uuids,
                self._workspace_id,
            )
            return [self._row_to_node(row) for row in rows]

    async def update(
        self,
        node_id: int,
        data: NodeUpdateData,
        user_id: int | None = None,
    ) -> Node | None:
        """Update a node."""
        now = utc_now()
        uid = user_id or self._user_id

        set_clauses = ["version = version + 1", "write_date = $1", "write_uid = $2"]
        params: list[Any] = [now, uid]
        param_idx = 3

        if data.name is not None:
            normalized_name = _normalize_name_to_ast(data.name)
            set_clauses.append(f"name = ${param_idx}")
            params.append(normalized_name)
            param_idx += 1

        if data.icon is not None:
            set_clauses.append(f"icon = ${param_idx}")
            params.append(data.icon)
            param_idx += 1
        elif data.clear_icon:
            set_clauses.append("icon = NULL")

        if data.color is not None:
            set_clauses.append(f"color = ${param_idx}")
            params.append(data.color)
            param_idx += 1
        elif data.clear_color:
            set_clauses.append("color = NULL")

        if data.parent_id is not None:
            set_clauses.append(f"parent_id = ${param_idx}")
            params.append(data.parent_id)
            param_idx += 1
            # Check if this node is (or will be) a page - pages never have page_id
            current_node = await self.get_by_id(node_id)
            node_is_page = current_node.is_page if current_node else False
            if data.classes is not None:
                class_nodes = await self.get_by_ids(data.classes)
                node_is_page = compute_node_flags(class_nodes).get("is_page", False)
            if node_is_page:
                page_id = None
            elif await self._is_page(data.parent_id):
                page_id = data.parent_id
            else:
                page_id = await self._compute_page_id(data.parent_id)
            set_clauses.append(f"page_id = ${param_idx}")
            params.append(page_id)
            param_idx += 1
        elif data.clear_parent:
            set_clauses.append("parent_id = NULL")
            set_clauses.append("page_id = NULL")

        if data.sequence is not None:
            set_clauses.append(f"sequence = ${param_idx}")
            params.append(data.sequence)
            param_idx += 1

        if data.collapsed is not None:
            set_clauses.append(f"collapsed = ${param_idx}")
            params.append(data.collapsed)
            param_idx += 1

        if data.is_private is not None:
            set_clauses.append(f"is_private = ${param_idx}")
            params.append(data.is_private)
            param_idx += 1

        if data.classes is not None:
            class_nodes = await self.get_by_ids(data.classes)
            flags = compute_node_flags(class_nodes)

            for flag_name, flag_value in flags.items():
                set_clauses.append(f"{flag_name} = ${param_idx}")
                params.append(flag_value)
                param_idx += 1

        where_clause = f"id = ${param_idx} AND workspace_id = ${param_idx + 1}"
        params.append(node_id)
        params.append(self._workspace_id)
        param_idx += 2

        query = f"""
            UPDATE node
            SET {", ".join(set_clauses)}
            WHERE {where_clause}
            RETURNING *
        """

        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(query, *params)
            return self._row_to_node(row) if row else None

    async def update_descendant_page_ids(
        self, node_id: int, new_page_id: int | None
    ) -> None:
        """Set page_id on all descendants of node_id (excluding node_id itself).

        Used when a node's containing page changes so its subtree keeps the
        correct page reference without rewriting parent_id hierarchy.
        """
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                WITH RECURSIVE descendants AS (
                    SELECT id, 0 AS depth
                    FROM node
                    WHERE id = $1 AND workspace_id = $2
                    UNION ALL
                    SELECT n.id, d.depth + 1
                    FROM node n
                    INNER JOIN descendants d ON n.parent_id = d.id
                    WHERE n.workspace_id = $2 AND d.depth < 100
                )
                UPDATE node
                SET page_id = $3,
                    write_date = NOW(),
                    version = version + 1
                WHERE id IN (SELECT id FROM descendants WHERE depth > 0)
                  AND workspace_id = $2
                """,
                node_id,
                self._workspace_id,
                new_page_id,
            )

    async def update_names_batch(
        self, updates: list[tuple[int, str]], user_id: int | None = None
    ) -> None:
        """Bulk-update node names, versions, and audit columns."""
        if not updates:
            return

        now = utc_now()
        uid = user_id or self._user_id

        ids: list[int] = []
        names: list[str | None] = []
        for node_id, name in updates:
            ids.append(node_id)
            names.append(_normalize_name_to_ast(name))

        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                UPDATE node
                SET name = u.name,
                    version = version + 1,
                    write_date = $1,
                    write_uid = $2
                FROM (
                    SELECT unnest($3::int[]) AS id,
                           unnest($4::text[]) AS name
                ) u
                WHERE node.id = u.id AND node.workspace_id = $5
                """,
                now,
                uid,
                ids,
                names,
                self._workspace_id,
            )

    async def delete(self, node_id: int) -> bool:
        """Delete a node and all its children (soft delete via is_deleted)."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                WITH RECURSIVE descendants AS (
                    SELECT id, 0 AS depth
                    FROM node
                    WHERE id = $1 AND workspace_id = $2
                    UNION ALL
                    SELECT n.id, d.depth + 1
                    FROM node n
                    INNER JOIN descendants d ON n.parent_id = d.id
                    WHERE n.workspace_id = $2
                )
                SELECT id FROM descendants
            """,
                node_id,
                self._workspace_id,
            )

            if not rows:
                return False

            ids_to_delete = [row["id"] for row in rows]
            now = utc_now()
            await conn.execute(
                """
                UPDATE node SET is_deleted = TRUE, deleted_at = $1, write_date = $1, write_uid = $2
                WHERE id = ANY($3) AND workspace_id = $4
            """,
                now,
                self._user_id,
                ids_to_delete,
                self._workspace_id,
            )

            return True

    async def hard_delete(self, node_id: int) -> bool:
        """Permanently delete a node and all its children."""
        from app.logging_config import get_logger

        logger = get_logger(__name__)

        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                WITH RECURSIVE descendants AS (
                    SELECT id, 0 AS depth
                    FROM node
                    WHERE id = $1 AND workspace_id = $2
                    UNION ALL
                    SELECT n.id, d.depth + 1
                    FROM node n
                    INNER JOIN descendants d ON n.parent_id = d.id
                    WHERE n.workspace_id = $2
                )
                SELECT id FROM descendants
            """,
                node_id,
                self._workspace_id,
            )

            logger.info(
                f"[HARD_DELETE] node_id={node_id}, workspace_id={self._workspace_id}, found {len(rows)} descendants via CTE"
            )

            if not rows:
                logger.info("[HARD_DELETE] No descendants found, trying direct delete")
                result = await conn.execute(
                    "DELETE FROM node WHERE id = $1 AND workspace_id = $2",
                    node_id,
                    self._workspace_id,
                )
                logger.info(f"[HARD_DELETE] Direct delete result: {result}")
                return "DELETE 1" in result

            ids_to_delete = [row["id"] for row in rows]
            logger.info(f"[HARD_DELETE] Deleting node ids: {ids_to_delete}")

            result = await conn.execute(
                "DELETE FROM node WHERE id = ANY($1) AND workspace_id = $2",
                ids_to_delete,
                self._workspace_id,
            )
            logger.info(f"[HARD_DELETE] Delete result: {result}")
            return True

    async def get_children(self, parent_id: int, limit: int = 5000) -> list[Node]:
        """Get direct children of a node (excludes comments).

        A default LIMIT prevents unbounded responses for nodes with huge numbers
        of children. Callers that legitimately need more should paginate.
        """
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                f"SELECT {_NODE_SELECT_COLUMNS} FROM node WHERE parent_id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE AND is_comment = FALSE ORDER BY sequence LIMIT $3",
                parent_id,
                self._workspace_id,
                limit,
            )
            return [self._row_to_node(row) for row in rows]

    async def get_page_content(self, page_id: int, limit: int = 5000) -> list[Node]:
        """Get nodes belonging to a page (recursive children), excluding comments.

        Capped to avoid OOM for pages with tens of thousands of blocks.
        Callers should load large pages in chunks if they hit the cap.
        """
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT
                    id, uuid, workspace_id, name, icon, color, parent_id, page_id,
                    sequence, collapsed, active, is_shared, version, is_deleted,
                    deleted_at, is_class, is_page, is_day, is_month, is_year,
                    is_asset, is_template, is_comment, is_table, parent_locked, is_private,
                    class_ids, classes_path, open_date, create_date, write_date,
                    create_uid, write_uid, aliased_id
                FROM node
                WHERE page_id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE AND is_comment = FALSE
                ORDER BY sequence
                LIMIT $3
            """,
                page_id,
                self._workspace_id,
                limit,
            )
            return [self._row_to_node(row) for row in rows]

    async def set_active(self, node_id: int, active: bool, user_id: int | None = None) -> Node | None:
        """Set the active status of a node (archive/unarchive)."""
        now = utc_now()
        uid = user_id or self._user_id
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                UPDATE node
                SET active = $1, write_date = $2, write_uid = $3, version = version + 1
                WHERE id = $4 AND workspace_id = $5
                RETURNING *
            """,
                active,
                now,
                uid,
                node_id,
                self._workspace_id,
            )
            return self._row_to_node(row) if row else None

    async def update_open_date(self, node_id: int) -> Node | None:
        """Update the open_date timestamp for a node."""
        now = utc_now()
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                UPDATE node
                SET open_date = $1
                WHERE id = $2 AND workspace_id = $3
                RETURNING *
            """,
                now,
                node_id,
                self._workspace_id,
            )
            return self._row_to_node(row) if row else None

    async def get_archived_pages_paginated(
        self, page: int, page_size: int
    ) -> tuple[list[Node], int]:
        """Get archived pages with total count."""
        offset = (page - 1) * page_size
        async with acquire_connection(self._pool) as conn:
            count_row = await conn.fetchrow(
                """
                SELECT COUNT(*) as total FROM node
                WHERE is_page = true AND active = false
                      AND (is_deleted = false OR is_deleted IS NULL)
                      AND workspace_id = $1
                """,
                self._workspace_id,
            )
            total = count_row["total"] if count_row else 0

            rows = await conn.fetch(
                f"""
                SELECT {_NODE_SELECT_COLUMNS} FROM node
                WHERE is_page = true AND active = false
                      AND (is_deleted = false OR is_deleted IS NULL)
                      AND workspace_id = $1
                ORDER BY write_date DESC NULLS LAST
                LIMIT $2 OFFSET $3
            """,
                self._workspace_id,
                page_size,
                offset,
            )
            return [self._row_to_node(row) for row in rows], total

    async def get_node_versions(self, node_id: int, limit: int) -> list[asyncpg.Record]:
        """Get version history rows for a node."""
        async with acquire_connection(self._pool) as conn:
            return await conn.fetch(
                """
                SELECT nv.id, nv.name, nv.created_at, nv.user_id, u.username
                FROM node_version nv
                LEFT JOIN "user" u ON u.id = nv.user_id
                WHERE nv.node_id = $1 AND nv.workspace_id = $2
                ORDER BY nv.created_at DESC
                LIMIT $3
            """,
                node_id,
                self._workspace_id,
                limit,
            )

    async def get_node_version(self, node_id: int, version_id: int) -> str | None:
        """Get the stored name for a specific node version."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT name FROM node_version
                WHERE id = $1 AND node_id = $2 AND workspace_id = $3
            """,
                version_id,
                node_id,
                self._workspace_id,
            )
            return row["name"] if row else None

    # ============== Bulk / Ad-hoc Operations (migrated from domain services) ==============

    async def find_page_by_name(self, name: str, parent_id: int | None = None) -> list[asyncpg.Record]:
        """Find pages with the given name and parent, returning raw rows with class info."""
        async with acquire_connection(self._pool) as conn:
            return await conn.fetch(
                """
                SELECT n.id, n.name, nl.target_id as class_id, class_node.name as class_name
                FROM node n
                LEFT JOIN node_link nl ON nl.source_id = n.id AND nl.is_inline_class = TRUE
                LEFT JOIN node class_node ON class_node.id = nl.target_id
                WHERE n.workspace_id = $1 AND n.name = $2 AND n.is_page = TRUE AND n.active = TRUE
                  AND ($3::INTEGER IS NULL AND n.parent_id IS NULL OR n.parent_id = $3)
            """,
                self._workspace_id,
                name,
                parent_id,
            )

    async def has_circular_reference(self, ancestor_id: int, descendant_id: int) -> bool:
        """Check if setting ancestor_id as parent of descendant_id would create a cycle."""
        async with acquire_connection(self._pool) as conn:
            # Check if descendant_id is already a descendant of ancestor_id
            # (would create cycle if we make ancestor_id the parent)
            row = await conn.fetchrow(
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
                SELECT 1 FROM descendants WHERE id = $2 AND depth > 0
                """,
                ancestor_id,
                descendant_id,
            )
            return row is not None

    async def get_depth_info(self, node_id: int) -> tuple[int, int]:
        """Get (parent_depth, subtree_depth) for a node using recursive CTE."""
        async with acquire_connection(self._pool) as conn:
            parent_row = await conn.fetchrow(
                """
                WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id, 0 AS depth
                    FROM node
                    WHERE id = $1
                    UNION ALL
                    SELECT n.id, n.parent_id, a.depth + 1
                    FROM node n
                    INNER JOIN ancestors a ON n.id = a.parent_id
                )
                SELECT COALESCE(MAX(depth), 0) as parent_depth FROM ancestors
                """,
                node_id,
            )
            subtree_row = await conn.fetchrow(
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
                SELECT COALESCE(MAX(depth), 0) as subtree_depth FROM descendants
                """,
                node_id,
            )
            return (
                parent_row["parent_depth"] if parent_row else 0,
                subtree_row["subtree_depth"] if subtree_row else 0,
            )

    async def get_inline_class_ids(self, node_id: int) -> list[int]:
        """Get inline class IDs (from node_link with is_inline_class=TRUE) for a node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT target_id as class_id FROM node_link WHERE source_id = $1 AND is_inline_class = TRUE ORDER BY position",
                node_id,
            )
            return [row["class_id"] for row in rows]

    async def get_deleted_nodes(self) -> list[Node]:
        """Get all soft-deleted nodes in the workspace ordered by deleted_at DESC."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                f"SELECT {_NODE_SELECT_COLUMNS}, is_deleted, deleted_at FROM node WHERE workspace_id = $1 AND is_deleted = true ORDER BY deleted_at DESC NULLS LAST",
                self._workspace_id,
            )
            return [self._row_to_node(row) for row in rows]

    async def get_node_by_id_with_workspace(self, node_id: int) -> Node | None:
        """Get a node by ID, verifying it belongs to this workspace."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                f"SELECT {_NODE_SELECT_COLUMNS}, is_deleted, deleted_at FROM node WHERE id = $1 AND workspace_id = $2", node_id, self._workspace_id
            )
            return self._row_to_node(row) if row else None

    async def soft_delete_nodes(self, node_ids: list[int], deleted_at: str, write_uid: int) -> None:
        """Bulk soft-delete nodes by setting is_deleted=TRUE and deleted_at."""
        if not node_ids:
            return
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """UPDATE node SET is_deleted = TRUE, deleted_at = $1, write_date = $1, write_uid = $2
                   WHERE id = ANY($3::integer[]) AND workspace_id = $4""",
                deleted_at,
                write_uid,
                node_ids,
                self._workspace_id,
            )

    async def restore_nodes(self, node_ids: list[int], write_date: str, write_uid: int) -> None:
        """Bulk restore nodes from trash."""
        if not node_ids:
            return
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """UPDATE node SET is_deleted = FALSE, deleted_at = NULL, write_date = $1, write_uid = $2
                   WHERE id = ANY($3::integer[]) AND workspace_id = $4""",
                write_date,
                write_uid,
                node_ids,
                self._workspace_id,
            )

    async def hard_delete_nodes(self, node_ids: list[int]) -> None:
        """Bulk permanently delete nodes (assumes they are already in trash)."""
        if not node_ids:
            return
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "DELETE FROM node WHERE id = ANY($1::integer[]) AND workspace_id = $2", node_ids, self._workspace_id
            )

    async def get_trash_node_ids(self) -> list[int]:
        """Get IDs of all soft-deleted nodes in the workspace."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT id FROM node WHERE workspace_id = $1 AND is_deleted = true", self._workspace_id
            )
            return [row["id"] for row in rows]

    async def node_exists(self, node_id: int) -> bool:
        """Check if a node exists in this workspace."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT id FROM node WHERE id = $1 AND workspace_id = $2", node_id, self._workspace_id
            )
            return row is not None

    async def get_children_ids(self, parent_id: int) -> list[int]:
        """Get direct child IDs of a node ordered by sequence (excludes comments)."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT id FROM node WHERE parent_id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE AND is_comment = FALSE ORDER BY sequence",
                parent_id,
                self._workspace_id,
            )
            return [row["id"] for row in rows]

    async def get_max_sequence(self, parent_id: int) -> float:
        """Get the maximum sequence among children of a parent."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT COALESCE(MAX(sequence), -1) as max_seq FROM node WHERE parent_id = $1 AND workspace_id = $2",
                parent_id,
                self._workspace_id,
            )
            return row["max_seq"] if row else -1

    async def reparent_nodes(
        self, node_ids: list[int], new_parent_id: int, new_page_id: int, start_sequence: float
    ) -> None:
        """Reparent multiple nodes to a new parent with sequential ordering."""
        if not node_ids:
            return
        async with acquire_connection(self._pool) as conn:
            for idx, node_id in enumerate(node_ids):
                await conn.execute(
                    """UPDATE node SET parent_id = $1, page_id = $2, sequence = $3,
                       write_date = NOW(), version = version + 1
                       WHERE id = $4 AND workspace_id = $5""",
                    new_parent_id,
                    new_page_id,
                    start_sequence + idx,
                    node_id,
                    self._workspace_id,
                )

    async def archive_nodes(self, node_ids: list[int], write_date: str, write_uid: int) -> None:
        """Bulk archive nodes by setting active=FALSE."""
        if not node_ids:
            return
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """UPDATE node SET active = FALSE, write_date = $1, write_uid = $2, version = version + 1
                   WHERE id = ANY($3::integer[]) AND workspace_id = $4""",
                write_date,
                write_uid,
                node_ids,
                self._workspace_id,
            )

    async def unarchive_nodes(self, node_ids: list[int], write_date: str, write_uid: int) -> None:
        """Bulk unarchive nodes by setting active=TRUE."""
        if not node_ids:
            return
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """UPDATE node SET active = TRUE, write_date = $1, write_uid = $2, version = version + 1
                   WHERE id = ANY($3::integer[]) AND workspace_id = $4""",
                write_date,
                write_uid,
                node_ids,
                self._workspace_id,
            )

    async def count_active_day_descendants(self, node_id: int) -> int:
        """Count active day-page descendants of a node."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                WITH RECURSIVE descendants AS (
                    SELECT id, 0 AS depth
                    FROM node
                    WHERE id = $1 AND workspace_id = $2 AND active = TRUE
                    UNION ALL
                    SELECT n.id, d.depth + 1
                    FROM node n
                    INNER JOIN descendants d ON n.parent_id = d.id
                    WHERE n.workspace_id = $2 AND n.active = TRUE
                )
                SELECT COUNT(*) as day_count
                FROM descendants d
                JOIN node n ON n.id = d.id
                WHERE d.depth > 0 AND n.is_day = TRUE
            """,
                node_id,
                self._workspace_id,
            )
            return row["day_count"] if row else 0

    async def list_templates(self) -> list[Node]:
        """List all active templates in the workspace."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                f"""SELECT {_NODE_SELECT_COLUMNS} FROM node
                   WHERE workspace_id = $1 AND is_template = TRUE AND active = TRUE
                     AND (is_deleted = FALSE OR is_deleted IS NULL)
                   ORDER BY name""",
                self._workspace_id,
            )
            return [self._row_to_node(row) for row in rows]

    async def list_templates_paginated(
        self, page: int, page_size: int
    ) -> tuple[list[Node], int]:
        """List active templates with total count."""
        offset = (page - 1) * page_size
        async with acquire_connection(self._pool) as conn:
            count_row = await conn.fetchrow(
                """
                SELECT COUNT(*) as total FROM node
                WHERE workspace_id = $1 AND is_template = TRUE AND active = TRUE
                      AND (is_deleted = FALSE OR is_deleted IS NULL)
                """,
                self._workspace_id,
            )
            total = count_row["total"] if count_row else 0

            rows = await conn.fetch(
                f"""
                SELECT {_NODE_SELECT_COLUMNS} FROM node
                WHERE workspace_id = $1 AND is_template = TRUE AND active = TRUE
                      AND (is_deleted = FALSE OR is_deleted IS NULL)
                ORDER BY name
                LIMIT $2 OFFSET $3
            """,
                self._workspace_id,
                page_size,
                offset,
            )
            return [self._row_to_node(row) for row in rows], total

    async def get_template_descendants(self, template_id: int) -> list[Node]:
        """Get all descendant nodes of a template (excluding the template itself)."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                WITH RECURSIVE descendants AS (
                    SELECT id, 0 AS depth
                    FROM node
                    WHERE id = $1 AND workspace_id = $2 AND active = TRUE
                    UNION ALL
                    SELECT n.id, d.depth + 1
                    FROM node n
                    INNER JOIN descendants d ON n.parent_id = d.id
                    WHERE n.workspace_id = $2 AND n.active = TRUE
                )
                SELECT n.id, n.uuid, n.name, n.icon, n.color, n.parent_id, n.sequence,
                       n.class_ids, n.collapsed
                FROM descendants d
                JOIN node n ON n.id = d.id
                WHERE d.depth > 0
                  AND (n.is_deleted = FALSE OR n.is_deleted IS NULL)
                ORDER BY d.depth, n.sequence
            """,
                template_id,
                self._workspace_id,
            )
            return [self._row_to_node(row) for row in rows]

    async def list_classes(self) -> list[Node]:
        """List all active class nodes in the workspace, ordered by name."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                f"SELECT {_NODE_SELECT_COLUMNS} FROM node WHERE is_class = TRUE AND active = TRUE AND workspace_id = $1 ORDER BY name",
                self._workspace_id,
            )
            return [self._row_to_node(row) for row in rows]

    async def search_classes(self, q: str, limit: int = 20) -> list[Node]:
        """Search class nodes by name (ILIKE) and full-text search."""
        name_text = """(CASE
            WHEN name IS NOT NULL AND name LIKE '[%' THEN
                COALESCE((SELECT string_agg(t #>> '{}', '') FROM jsonb_path_query(name::jsonb, '$.**.text') AS t), '')
            ELSE COALESCE(name, '')
        END)"""

        async with acquire_connection(self._pool) as conn:
            if len(q) >= 3:
                rows = await conn.fetch(
                    f"""
                    SELECT {_NODE_SELECT_COLUMNS}, ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
                    FROM node
                    WHERE workspace_id = $2 AND active = TRUE AND is_deleted = FALSE
                      AND is_class = TRUE AND parent_id IS NULL
                      AND (search_vector @@ plainto_tsquery('english', $1) OR {name_text} ILIKE $3)
                    ORDER BY
                        (LOWER({name_text}) = LOWER($1)) DESC,
                        (LOWER({name_text}) LIKE LOWER($1) || '%') DESC,
                        rank DESC,
                        write_date DESC
                    LIMIT $4
                """,
                    q,
                    self._workspace_id,
                    f"%{q}%",
                    limit,
                )
            else:
                rows = await conn.fetch(
                    f"""
                    SELECT {_NODE_SELECT_COLUMNS} FROM node
                    WHERE {name_text} ILIKE $1
                      AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE
                      AND is_class = TRUE AND parent_id IS NULL
                    ORDER BY
                        (LOWER({name_text}) = LOWER($4)) DESC,
                        (LOWER({name_text}) LIKE LOWER($4) || '%') DESC,
                        write_date DESC
                    LIMIT $3
                """,
                    f"%{q}%",
                    self._workspace_id,
                    limit,
                    q,
                )

            return [self._row_to_node(row) for row in rows]

    async def get_nodes_with_classes(self, class_ids: list[int], limit: int | None = None, offset: int | None = None) -> list[Node]:
        """Get all nodes that have any of the given class IDs in their class_ids array."""
        async with acquire_connection(self._pool) as conn:
            params: list = [class_ids, self._workspace_id]
            limit_clause = ""
            if limit is not None:
                limit_clause = f" LIMIT ${len(params) + 1}"
                params.append(limit)
                if offset is not None:
                    limit_clause += f" OFFSET ${len(params) + 1}"
                    params.append(offset)
            rows = await conn.fetch(
                f"""SELECT {_NODE_SELECT_COLUMNS} FROM node
                   WHERE class_ids && $1::integer[]
                     AND workspace_id = $2
                     AND active = TRUE
                   ORDER BY write_date DESC{limit_clause}""",
                *params,
            )
            return [self._row_to_node(row) for row in rows]

    async def count_nodes_with_classes(self, class_ids: list[int]) -> int:
        """Count nodes that have any of the given class IDs in their class_ids array."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """SELECT COUNT(*) FROM node
                   WHERE class_ids && $1::integer[]
                     AND workspace_id = $2
                     AND active = TRUE""",
                class_ids,
                self._workspace_id,
            )
            return row["count"] if row else 0

    async def get_node_sequence(self, node_id: int) -> float | None:
        """Get the sequence of a node."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT sequence FROM node WHERE id = $1 AND workspace_id = $2", node_id, self._workspace_id
            )
            return row["sequence"] if row else None

    async def shift_sequences(self, parent_id: int, from_sequence: float, amount: float) -> None:
        """Shift sequences of children at or after from_sequence by amount."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """UPDATE node SET sequence = sequence + $1
                   WHERE parent_id = $2 AND sequence > $3
                     AND workspace_id = $4 AND active = TRUE""",
                amount,
                parent_id,
                from_sequence,
                self._workspace_id,
            )

    async def find_node_id_by_uuid(self, uuid: str) -> int | None:
        """Find a node ID by UUID in this workspace."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT id FROM node WHERE uuid::text = $1 AND workspace_id = $2", uuid, self._workspace_id
            )
            return row["id"] if row else None

    async def get_page_id_by_uuid(self, uuid: str) -> int | None:
        """Get the ID of an active page node by UUID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT id FROM node WHERE uuid::text = $1 AND active = TRUE AND workspace_id = $2",
                uuid,
                self._workspace_id,
            )
            return row["id"] if row else None

    async def get_page_class_id(self) -> int | None:
        """Return the integer ID of the page class in this workspace."""
        from app.db.schema.constants import SYSTEM_CLASS_UUIDS

        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT id FROM node WHERE uuid = $1 AND is_class = TRUE AND workspace_id = $2 LIMIT 1",
                SYSTEM_CLASS_UUIDS["page"],
                self._workspace_id,
            )
            return row["id"] if row else None

    async def search_by_uuid_prefix(self, uuid_prefix: str, limit: int) -> list[Node]:
        """Search active nodes by UUID prefix."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """SELECT n.* FROM node n
                WHERE n.workspace_id = $1 AND n.active = TRUE AND n.is_deleted = FALSE
                  AND n.uuid::text LIKE $2
                ORDER BY n.write_date DESC NULLS LAST
                LIMIT $3""",
                self._workspace_id,
                uuid_prefix + "%",
                limit,
            )
            return [self._row_to_node(row) for row in rows]

    async def get_node_names_by_uuids(self, uuids: list[str]) -> dict[str, str | None]:
        """Fetch node names for the given UUIDs in this workspace."""
        if not uuids:
            return {}
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT uuid::text AS uuid, name FROM node WHERE workspace_id = $1 AND uuid::text = ANY($2::text[])",
                self._workspace_id,
                uuids,
            )
            return {row["uuid"]: row["name"] for row in rows}

    async def resolve_referenced_display_names(self, target_rows: list[Any]) -> dict[str, str]:
        """Resolve node links embedded in names and return uuid -> resolved plain-text map."""

        def _row_name(row):
            if hasattr(row, "name"):
                return row.name or ""
            return row.get("name", "") if isinstance(row, dict) else row["name"] or ""

        def _row_uuid(row):
            if hasattr(row, "uuid"):
                return str(row.uuid)
            return str(row.get("uuid", "")) if isinstance(row, dict) else str(row["uuid"])

        link_node_uuids: set[str] = set()
        for row in target_rows:
            name = _row_name(row)
            for match in re.finditer(r'"link_id"\s*:\s*"([^"]+)"', name):
                link_id = match.group(1)
                colon = link_id.find(":")
                node_uuid = link_id[:colon] if colon > 0 else link_id
                link_node_uuids.add(node_uuid)

        link_target_map: dict[str, Any] = {}
        if link_node_uuids:
            name_map = await self.get_node_names_by_uuids(list(link_node_uuids))
            for node_uuid, name in name_map.items():
                if name is not None:
                    link_target_map[node_uuid] = parse_ast(name)

        if not link_target_map:
            return {}

        def _resolve_link(link_id: str):
            colon = link_id.find(":")
            node_uuid = link_id[:colon] if colon > 0 else link_id
            target_ast = link_target_map.get(node_uuid)
            if target_ast is None:
                return None
            return NodeLinkResolution(target_ast=target_ast, label=None, target_id=node_uuid)

        opts = StringifyOptions(
            mode=StringifyMode.TEXT_ONLY,
            resolve_node_link=_resolve_link,
        )

        result: dict[str, str] = {}
        for row in target_rows:
            name = _row_name(row)
            if '"link_id"' in name:
                resolved = stringify_ast(parse_ast(name), opts)
                if resolved:
                    result[_row_uuid(row)] = resolved

        return result

    async def get_workspace_data(
        self, page: int, page_size: int
    ) -> tuple[int, list[dict[str, Any]], list[dict[str, Any]]]:
        """Return workspace visualization data: (total, nodes, links)."""
        from app.db.schema.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PAGE_UUIDS

        excluded_uuids = [
            SYSTEM_CLASS_UUIDS["page"],
            SYSTEM_CLASS_UUIDS["class"],
            *SYSTEM_PAGE_UUIDS.values(),
        ]
        offset = (page - 1) * page_size

        async with acquire_connection(self._pool) as conn:
            total = await conn.fetchval(
                """
                SELECT COUNT(*) FROM node
                WHERE workspace_id = $1 AND is_page = TRUE AND active = TRUE
                  AND uuid::text NOT IN (SELECT unnest($2::text[]))
            """,
                self._workspace_id,
                excluded_uuids,
            )

            page_rows = await conn.fetch(
                """
                SELECT id, uuid, name, icon, is_class, is_day, is_month, is_year, aliased_id
                FROM node
                WHERE workspace_id = $1 AND is_page = TRUE AND active = TRUE
                  AND uuid::text NOT IN (SELECT unnest($2::text[]))
                ORDER BY name
                LIMIT $3 OFFSET $4
            """,
                self._workspace_id,
                excluded_uuids,
                page_size,
                offset,
            )

            page_ids = [row["id"] for row in page_rows]
            class_ids_map = (
                await self.get_class_ids_batch(page_ids) if page_ids else {}
            )

            block_count_map: dict[int, int] = {}
            if page_ids:
                block_count_rows = await conn.fetch(
                    """
                    SELECT page_id, COUNT(*) as block_count
                    FROM node
                    WHERE workspace_id = $1 AND is_page = FALSE AND active = TRUE AND page_id IS NOT NULL
                    GROUP BY page_id
                """,
                    self._workspace_id,
                )
                block_count_map = {row["page_id"]: row["block_count"] for row in block_count_rows}

            nodes = []
            for row in page_rows:
                node_class_ids = class_ids_map.get(row["id"], [])
                nodes.append(
                    {
                        "id": row["id"],
                        "uuid": str(row["uuid"]),
                        "name": row["name"],
                        "icon": row["icon"],
                        "is_class": row["is_class"],
                        "is_daily": row["is_day"],
                        "is_monthly": row["is_month"],
                        "is_yearly": row["is_year"],
                        "class_ids": node_class_ids,
                        "block_count": block_count_map.get(row["id"], 0),
                        "aliased_id": row["aliased_id"],
                    }
                )

            page_id_set = {row["id"] for row in page_rows}

            link_rows = await conn.fetch(
                """
                SELECT DISTINCT nl.source_id, nl.target_id
                FROM node_link nl
                JOIN node source ON nl.source_id = source.id
                JOIN node target ON nl.target_id = target.id
                WHERE source.workspace_id = $1
                  AND target.workspace_id = $1
                  AND target.is_page = TRUE
                  AND source.active = TRUE
                  AND target.active = TRUE
            """,
                self._workspace_id,
            )

            block_source_ids = [row["source_id"] for row in link_rows if row["source_id"] not in page_id_set]
            block_to_page: dict[int, int] = {}
            if block_source_ids:
                block_rows = await conn.fetch(
                    "SELECT id, page_id FROM node WHERE id = ANY($1::int[])", block_source_ids
                )
                for br in block_rows:
                    if br["page_id"]:
                        block_to_page[br["id"]] = br["page_id"]

            links: list[dict[str, Any]] = []
            for row in link_rows:
                source_id = row["source_id"]
                target_id = row["target_id"]
                source_page_id = source_id
                if source_id not in page_id_set:
                    source_page_id = block_to_page.get(source_id, source_id)
                if source_page_id in page_id_set and target_id in page_id_set:
                    links.append({"source": source_page_id, "target": target_id, "type": "reference"})

            parent_rows = await conn.fetch(
                """
                SELECT child.id as child_id, parent.id as parent_id
                FROM node child
                JOIN node parent ON child.parent_id = parent.id
                WHERE child.workspace_id = $1
                  AND child.is_page = TRUE
                  AND parent.is_page = TRUE
                  AND child.active = TRUE
                  AND parent.active = TRUE
            """,
                self._workspace_id,
            )
            for row in parent_rows:
                child_id = row["child_id"]
                parent_id = row["parent_id"]
                if child_id in page_id_set and parent_id in page_id_set:
                    links.append({"source": parent_id, "target": child_id, "type": "parent"})

            for row in page_rows:
                node_id = row["id"]
                node_class_ids = class_ids_map.get(node_id, [])
                for class_id in node_class_ids:
                    if class_id in page_id_set:
                        links.append({"source": node_id, "target": class_id, "type": "class"})

            class_extends_rows = await conn.fetch(
                """
                SELECT ce.target_id as child_id, ce.source_id as parent_id
                FROM class_extend ce
                JOIN node child ON ce.target_id = child.id
                JOIN node parent ON ce.source_id = parent.id
                WHERE child.workspace_id = $1
                  AND parent.workspace_id = $1
                  AND child.active = TRUE
                  AND parent.active = TRUE
            """,
                self._workspace_id,
            )
            for row in class_extends_rows:
                child_id = row["child_id"]
                parent_id = row["parent_id"]
                if child_id in page_id_set and parent_id in page_id_set:
                    links.append({"source": child_id, "target": parent_id, "type": "extends"})

            property_link_rows = await conn.fetch(
                """
                SELECT DISTINCT pvr.node_id, pvr.target_id
                FROM property_value_relation pvr
                JOIN node source ON pvr.node_id = source.id
                JOIN node target ON pvr.target_id = target.id
                WHERE source.workspace_id = $1
                  AND target.workspace_id = $1
                  AND source.is_page = TRUE
                  AND target.is_page = TRUE
                  AND source.active = TRUE
                  AND target.active = TRUE
            """,
                self._workspace_id,
            )
            for row in property_link_rows:
                source_id = row["node_id"]
                target_id = row["target_id"]
                if source_id in page_id_set and target_id in page_id_set:
                    links.append({"source": source_id, "target": target_id, "type": "property-reference"})

            seen = set()
            unique_links = []
            for link in links:
                key = (link["source"], link["target"], link["type"])
                if key not in seen:
                    seen.add(key)
                    unique_links.append(link)

            return total, nodes, unique_links

    async def get_workspace_nodes(
        self, page: int, page_size: int
    ) -> tuple[int, list[dict[str, Any]]]:
        """Return workspace nodes without links: (total, nodes)."""
        from app.db.schema.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PAGE_UUIDS

        excluded_uuids = [
            SYSTEM_CLASS_UUIDS["page"],
            SYSTEM_CLASS_UUIDS["class"],
            *SYSTEM_PAGE_UUIDS.values(),
        ]
        offset = (page - 1) * page_size

        async with acquire_connection(self._pool) as conn:
            total = await conn.fetchval(
                """
                SELECT COUNT(*) FROM node
                WHERE workspace_id = $1 AND is_page = TRUE AND active = TRUE
                  AND uuid::text NOT IN (SELECT unnest($2::text[]))
            """,
                self._workspace_id,
                excluded_uuids,
            )

            page_rows = await conn.fetch(
                """
                SELECT id, uuid, name, icon, is_class, is_day, is_month, is_year, aliased_id
                FROM node
                WHERE workspace_id = $1 AND is_page = TRUE AND active = TRUE
                  AND uuid::text NOT IN (SELECT unnest($2::text[]))
                ORDER BY name
                LIMIT $3 OFFSET $4
            """,
                self._workspace_id,
                excluded_uuids,
                page_size,
                offset,
            )

            page_ids = [row["id"] for row in page_rows]
            class_ids_map = (
                await self.get_class_ids_batch(page_ids) if page_ids else {}
            )

            block_count_map: dict[int, int] = {}
            if page_ids:
                block_count_rows = await conn.fetch(
                    """
                    SELECT page_id, COUNT(*) as block_count
                    FROM node
                    WHERE workspace_id = $1 AND is_page = FALSE AND active = TRUE AND page_id IS NOT NULL
                    GROUP BY page_id
                """,
                    self._workspace_id,
                )
                block_count_map = {row["page_id"]: row["block_count"] for row in block_count_rows}

            nodes = []
            for row in page_rows:
                node_class_ids = class_ids_map.get(row["id"], [])
                nodes.append(
                    {
                        "id": row["id"],
                        "uuid": str(row["uuid"]),
                        "name": row["name"],
                        "icon": row["icon"],
                        "is_class": row["is_class"],
                        "is_daily": row["is_day"],
                        "is_monthly": row["is_month"],
                        "is_yearly": row["is_year"],
                        "class_ids": node_class_ids,
                        "block_count": block_count_map.get(row["id"], 0),
                    }
                )

            return total, nodes

    async def get_node_class_ids(self, node_id: int) -> list[int]:
        """Get the class_ids array for a node."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow("SELECT class_ids FROM node WHERE id = $1 AND workspace_id = $2", node_id, self._workspace_id)
            return row["class_ids"] if row and row["class_ids"] else []

    async def update_node_class_ids(self, node_id: int, class_ids: list[int]) -> None:
        """Update class_ids for a node."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "UPDATE node SET class_ids = $1, write_date = NOW(), version = version + 1 WHERE id = $2",
                class_ids,
                node_id,
            )

    async def get_node_tag_ids(self, node_id: int) -> list[int]:
        """Get the tag_ids array for a node."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow("SELECT tag_ids FROM node WHERE id = $1 AND workspace_id = $2", node_id, self._workspace_id)
            return row["tag_ids"] if row and row["tag_ids"] else []

    async def update_node_tag_ids(self, node_id: int, tag_ids: list[int]) -> None:
        """Update tag_ids for a node."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "UPDATE node SET tag_ids = $1, write_date = NOW(), version = version + 1 WHERE id = $2",
                tag_ids,
                node_id,
            )

    async def get_tag_ids_batch(self, node_ids: list[int]) -> dict[int, list[int]]:
        """Get tag_ids arrays for multiple nodes in a single query."""
        if not node_ids:
            return {}
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, tag_ids
                FROM node
                WHERE id = ANY($1) AND workspace_id = $2
            """,
                node_ids,
                self._workspace_id,
            )
            return {row["id"]: list(row["tag_ids"] or []) for row in rows}

    async def remove_tag_id_from_all_nodes(self, tag_id: int) -> int:
        """Remove a tag ID from all node.tag_ids arrays in the workspace."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                """
                UPDATE node
                SET tag_ids = array_remove(tag_ids, $1),
                    write_date = NOW(),
                    version = version + 1
                WHERE workspace_id = $2
                  AND tag_ids @> ARRAY[$1]::INTEGER[]
            """,
                tag_id,
                self._workspace_id,
            )
            return int(result.split()[-1]) if result and result.split()[-1].isdigit() else 0

    async def redirect_tag_ids(self, old_tag_id: int, new_tag_id: int) -> int:
        """Replace old_tag_id with new_tag_id in all node.tag_ids arrays."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                """
                UPDATE node
                SET tag_ids = ARRAY(
                    SELECT CASE WHEN x = $1 THEN $2 ELSE x END
                    FROM unnest(tag_ids) AS x
                ),
                    write_date = NOW(),
                    version = version + 1
                WHERE workspace_id = $3
                  AND tag_ids @> ARRAY[$1]::INTEGER[]
            """,
                old_tag_id,
                new_tag_id,
                self._workspace_id,
            )
            return int(result.split()[-1]) if result and result.split()[-1].isdigit() else 0

    async def redirect_property_relation_targets(self, old_target_id: int, new_target_id: int) -> int:
        """Update all property_value_relation records to point from old_target to new_target.

        Returns the number of rows updated.
        """
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "UPDATE property_value_relation SET target_id = $1 WHERE target_id = $2", new_target_id, old_target_id
            )
            return int(result.split()[-1]) if result and result.split()[-1].isdigit() else 0

    async def get_active_nodes(self, limit: int | None = None) -> list[Node]:
        """Get all active nodes in the workspace, optionally limited."""
        async with acquire_connection(self._pool) as conn:
            limit_clause = ""
            params: list[Any] = [self._workspace_id]
            if limit is not None:
                limit_clause = f" LIMIT ${len(params) + 1}"
                params.append(limit)
            rows = await conn.fetch(
                f"""SELECT {_NODE_SELECT_COLUMNS} FROM node
                   WHERE workspace_id = $1 AND active = TRUE
                   ORDER BY id{limit_clause}""",
                *params,
            )
            return [self._row_to_node(row) for row in rows]

    async def get_class_ids_batch(self, node_ids: list[int]) -> dict[int, list[int]]:
        """Get class_ids arrays for multiple nodes in a single query."""
        if not node_ids:
            return {}
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, class_ids
                FROM node
                WHERE id = ANY($1) AND workspace_id = $2
            """,
                node_ids,
                self._workspace_id,
            )
            return {row["id"]: list(row["class_ids"] or []) for row in rows}

    async def find_active_nodes_by_name_patterns(self, patterns: list[str]) -> list[asyncpg.Record]:
        """Get active node id/name rows matching any of the given LIKE patterns."""
        if not patterns:
            return []
        async with acquire_connection(self._pool) as conn:
            # Query for nodes matching any pattern, ordered by id.
            # Use a subquery to avoid duplicates when a node matches multiple patterns.
            placeholders = ", ".join(f"${i + 2}" for i in range(len(patterns)))
            rows = await conn.fetch(
                f"""
                SELECT DISTINCT id, name
                FROM node
                WHERE workspace_id = $1 AND active = TRUE
                  AND name LIKE ANY(ARRAY[{placeholders}])
                ORDER BY id
            """,
                self._workspace_id,
                *patterns,
            )
            return list(rows)

    async def get_node_version_detail(
        self, version_id: int, node_id: int
    ) -> dict[str, Any] | None:
        """Get a single node version detail row including username."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT nv.id, nv.name, nv.created_at, nv.user_id,
                       u.username
                FROM node_version nv
                LEFT JOIN "user" u ON u.id = nv.user_id
                WHERE nv.id = $1 AND nv.node_id = $2 AND nv.workspace_id = $3
                """,
                version_id,
                node_id,
                self._workspace_id,
            )
        return dict(row) if row else None

    async def filter_existing_active_node_ids(
        self, node_ids: list[int]
    ) -> set[int]:
        """Return IDs of active, non-deleted nodes that exist in this workspace."""
        if not node_ids:
            return set()
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id FROM node
                WHERE id = ANY($1::int[]) AND workspace_id = $2
                      AND active = true
                      AND (is_deleted = false OR is_deleted IS NULL)
                """,
                node_ids,
                self._workspace_id,
            )
            return {row["id"] for row in rows}

    async def get_page_node_check(self, node_id: int) -> dict[str, Any] | None:
        """Get id and is_page for a node if active and in workspace."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT id, is_page FROM node WHERE id = $1 AND active = TRUE AND workspace_id = $2",
                node_id,
                self._workspace_id,
            )
            return dict(row) if row else None

    async def list_daily_pages_paginated(
        self, page: int, page_size: int
    ) -> tuple[int, list[asyncpg.Record]]:
        """List daily pages ordered by UUID desc."""
        offset = (page - 1) * page_size
        async with acquire_connection(self._pool) as conn:
            count_row = await conn.fetchrow(
                """
                SELECT COUNT(*) as total FROM node
                WHERE is_day = TRUE AND active = TRUE AND is_class = FALSE AND workspace_id = $1
                  AND (is_deleted = FALSE OR is_deleted IS NULL)
                """,
                self._workspace_id,
            )
            total = count_row["total"] if count_row else 0

            rows = await conn.fetch(
                f"""
                SELECT {_NODE_SELECT_COLUMNS} FROM node
                WHERE is_day = TRUE AND active = TRUE AND is_class = FALSE AND workspace_id = $1
                  AND (is_deleted = FALSE OR is_deleted IS NULL)
                ORDER BY uuid DESC
                LIMIT $2 OFFSET $3
                """,
                self._workspace_id,
                page_size,
                offset,
            )
            return total, rows

    async def get_comment_ids_paginated(
        self, parent_id: int, page: int, page_size: int
    ) -> tuple[int, list[int]]:
        """Get paginated top-level comment IDs under a node."""
        offset = (page - 1) * page_size
        async with acquire_connection(self._pool) as conn:
            count_row = await conn.fetchrow(
                """
                SELECT COUNT(*) as total FROM node
                WHERE parent_id = $1 AND is_comment = TRUE AND active = TRUE
                      AND (is_deleted = FALSE OR is_deleted IS NULL)
                """,
                parent_id,
            )
            total = count_row["total"] if count_row else 0

            rows = await conn.fetch(
                """
                SELECT id FROM node
                WHERE parent_id = $1 AND is_comment = TRUE AND active = TRUE
                      AND (is_deleted = FALSE OR is_deleted IS NULL)
                ORDER BY sequence, create_date
                LIMIT $2 OFFSET $3
                """,
                parent_id,
                page_size,
                offset,
            )
            return total, [row["id"] for row in rows]

    async def get_next_comment_sequence(self, parent_id: int) -> int:
        """Get the next sequence value for a comment under a parent."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT COALESCE(MAX(sequence), -1) + 1 as next_seq
                FROM node WHERE parent_id = $1 AND is_comment = TRUE AND active = TRUE
                      AND (is_deleted = FALSE OR is_deleted IS NULL)
                """,
                parent_id,
            )
            return row["next_seq"] if row else 0

    async def get_comment_count(self, node_id: int) -> int:
        """Count active comments under a node."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT COUNT(*) as count FROM node
                WHERE parent_id = $1 AND is_comment = TRUE AND active = TRUE
                      AND (is_deleted = FALSE OR is_deleted IS NULL)
                """,
                node_id,
            )
            return row["count"] if row else 0

    async def get_shared_node_children(
        self, node_id: int
    ) -> list[asyncpg.Record]:
        """Get non-page descendants of a shared node for public access."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                WITH RECURSIVE tree AS (
                    SELECT id, parent_id, sequence, 1 as depth,
                           LPAD(sequence::text, 4, '0') as path
                    FROM node
                    WHERE parent_id = $1
                      AND workspace_id = $2
                      AND active = TRUE
                      AND is_deleted = FALSE
                      AND is_page = FALSE
                    UNION ALL
                    SELECT n.id, n.parent_id, n.sequence, t.depth + 1,
                           t.path || '/' || LPAD(n.sequence::text, 4, '0')
                    FROM node n
                    JOIN tree t ON n.parent_id = t.id
                    WHERE n.workspace_id = $2
                      AND n.active = TRUE
                      AND n.is_deleted = FALSE
                      AND n.is_page = FALSE
                )
                SELECT n.*, t.depth
                FROM node n
                JOIN tree t ON n.id = t.id
                ORDER BY t.path
                """,
                node_id,
                self._workspace_id,
            )
            return list(rows)

    async def get_trash_paginated(
        self, page: int, page_size: int
    ) -> tuple[int, list[asyncpg.Record]]:
        """Get paginated soft-deleted nodes for the workspace."""
        offset = (page - 1) * page_size
        async with acquire_connection(self._pool) as conn:
            count_row = await conn.fetchrow(
                "SELECT COUNT(*) as total FROM node WHERE workspace_id = $1 AND is_deleted = true",
                self._workspace_id,
            )
            total = count_row["total"] if count_row else 0

            rows = await conn.fetch(
                f"""
                SELECT {_NODE_SELECT_COLUMNS}, is_deleted, deleted_at FROM node
                WHERE workspace_id = $1 AND is_deleted = true
                ORDER BY deleted_at DESC NULLS LAST
                LIMIT $2 OFFSET $3
                """,
                self._workspace_id,
                page_size,
                offset,
            )
            return total, rows
