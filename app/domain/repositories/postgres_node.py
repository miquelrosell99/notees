"""PostgreSQL implementation of Node repository  pure CRUD.

Hierarchy operations (move, breadcrumbs, ancestors, descendants) live in
postgres_node_hierarchy.py.  Search/listing operations live in
postgres_node_search.py.  Shared utilities live in postgres_node_base.py.
"""

from __future__ import annotations

from typing import Any

import asyncpg

from ...db.connection import acquire_connection
from ...utils import utc_now
from ..entities import Node, NodeCreateData, NodeUpdateData, generate_uuid
from .interfaces import NodeRepository
from .postgres_node_base import _normalize_name_to_ast
from .postgres_node_hierarchy import PostgresNodeHierarchyMixin
from .postgres_node_search import PostgresNodeSearchMixin

_NODE_SELECT_COLUMNS = (
    "id, uuid, workspace_id, name, icon, color, parent_id, page_id, sequence, collapsed, active, "
    "is_page, is_class, is_day, is_month, is_year, is_asset, is_template, is_comment, "
    "parent_locked, is_private, class_ids, classes_path, create_date, write_date, open_date, aliased_id"
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

        is_class = False
        is_page = False
        is_day = False
        is_month = False
        is_year = False
        is_asset = False
        is_template = False
        is_comment = False

        if data.classes:
            from ...db.schema.constants import SYSTEM_CLASS_UUIDS

            class_uuid_to_flag = {
                SYSTEM_CLASS_UUIDS["class"]: "is_class",
                SYSTEM_CLASS_UUIDS["page"]: "is_page",
                SYSTEM_CLASS_UUIDS["day"]: "is_day",
                SYSTEM_CLASS_UUIDS["month"]: "is_month",
                SYSTEM_CLASS_UUIDS["year"]: "is_year",
                SYSTEM_CLASS_UUIDS["asset"]: "is_asset",
                SYSTEM_CLASS_UUIDS["template"]: "is_template",
                SYSTEM_CLASS_UUIDS["comment"]: "is_comment",
            }

            for class_id in data.classes:
                class_node = await self.get_by_id(class_id)
                if class_node and class_node.uuid in class_uuid_to_flag:
                    flag_name = class_uuid_to_flag[class_node.uuid]
                    if flag_name == "is_class":
                        is_class = True
                    elif flag_name == "is_page":
                        is_page = True
                    elif flag_name == "is_day":
                        is_day = True
                    elif flag_name == "is_month":
                        is_month = True
                    elif flag_name == "is_year":
                        is_year = True
                    elif flag_name == "is_asset":
                        is_asset = True
                    elif flag_name == "is_template":
                        is_template = True
                    elif flag_name == "is_comment":
                        is_comment = True

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
                    is_asset, is_template, is_comment,
                    class_ids,
                    create_date, write_date, create_uid, write_uid
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19, $20, $20)
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
                data.classes if data.classes else [],
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
            is_template=is_template,
            is_comment=is_comment,
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
                from ...db.schema.constants import SYSTEM_CLASS_UUIDS

                page_class_uuid = SYSTEM_CLASS_UUIDS["page"]
                node_is_page = False
                for cid in data.classes:
                    cn = await self.get_by_id(cid)
                    if cn and cn.uuid == page_class_uuid:
                        node_is_page = True
                        break
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
            from ...db.schema.constants import SYSTEM_CLASS_UUIDS

            class_uuid_to_flag = {
                SYSTEM_CLASS_UUIDS["class"]: "is_class",
                SYSTEM_CLASS_UUIDS["page"]: "is_page",
                SYSTEM_CLASS_UUIDS["day"]: "is_day",
                SYSTEM_CLASS_UUIDS["month"]: "is_month",
                SYSTEM_CLASS_UUIDS["year"]: "is_year",
                SYSTEM_CLASS_UUIDS["asset"]: "is_asset",
                SYSTEM_CLASS_UUIDS["template"]: "is_template",
                SYSTEM_CLASS_UUIDS["comment"]: "is_comment",
            }

            flags = {
                "is_class": False,
                "is_page": False,
                "is_day": False,
                "is_month": False,
                "is_year": False,
                "is_asset": False,
                "is_template": False,
                "is_comment": False,
            }

            for class_id in data.classes:
                class_node = await self.get_by_id(class_id)
                if class_node and class_node.uuid in class_uuid_to_flag:
                    flags[class_uuid_to_flag[class_node.uuid]] = True

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

    async def get_children(self, parent_id: int) -> list[Node]:
        """Get direct children of a node (excludes comments)."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                f"SELECT {_NODE_SELECT_COLUMNS} FROM node WHERE parent_id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE AND is_comment = FALSE ORDER BY sequence",
                parent_id,
                self._workspace_id,
            )
            return [self._row_to_node(row) for row in rows]

    async def get_page_content(self, page_id: int) -> list[Node]:
        """Get all nodes belonging to a page (recursive children), excluding comments."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT
                    id, uuid, workspace_id, name, icon, color, parent_id, page_id,
                    sequence, collapsed, active, is_shared, version, is_deleted,
                    deleted_at, is_class, is_page, is_day, is_month, is_year,
                    is_asset, is_template, is_comment, parent_locked, is_private,
                    class_ids, classes_path, open_date, create_date, write_date,
                    create_uid, write_uid, aliased_id
                FROM node
                WHERE page_id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE AND is_comment = FALSE
                ORDER BY sequence
            """,
                page_id,
                self._workspace_id,
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

    async def redirect_property_relation_targets(self, old_target_id: int, new_target_id: int) -> int:
        """Update all property_value_relation records to point from old_target to new_target.

        Returns the number of rows updated.
        """
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "UPDATE property_value_relation SET target_id = $1 WHERE target_id = $2", new_target_id, old_target_id
            )
            return int(result.split()[-1]) if result and result.split()[-1].isdigit() else 0
