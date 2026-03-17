"""PostgreSQL implementation of Node repository  pure CRUD.

Hierarchy operations (move, breadcrumbs, ancestors, descendants) live in
postgres_node_hierarchy.py.  Search/listing operations live in
postgres_node_search.py.  Shared utilities live in postgres_node_base.py.
"""
from __future__ import annotations

from typing import Optional, List, Any

import asyncpg

from ..entities import Node, NodeCreateData, NodeUpdateData, generate_uuid
from ..errors import OptimisticLockError
from .interfaces import NodeRepository
from .postgres_node_base import _normalize_name_to_ast
from .postgres_node_hierarchy import PostgresNodeHierarchyMixin
from .postgres_node_search import PostgresNodeSearchMixin
from ...utils import utc_now
from ...db.connection import acquire_connection


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
        user_id: Optional[int] = None,
        uuid: Optional[str] = None,
    ) -> Node:
        """Create a new node."""
        if self._user_id:
            await self.permissions.require_workspace_create(self._workspace_id)

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

        async with acquire_connection(self._pool) as conn:
            async with conn.transaction():
                if data.parent_id is not None and data.sequence is not None:
                    await self._shift_siblings_for_insert(conn, data.parent_id, data.sequence)

                row = await conn.fetchrow("""
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
                """, uuid, self._workspace_id, normalized_name, data.icon, data.color,
                    data.parent_id, page_id, data.sequence, data.collapsed,
                    is_class, is_page, is_day,
                    is_month, is_year, is_asset,
                    is_template, is_comment,
                    data.classes if data.classes else [],
                    now, uid)

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

    async def get_by_id(self, node_id: int) -> Optional[Node]:
        """Get node by internal ID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT * FROM node WHERE id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
                node_id, self._workspace_id,
            )
            if not row:
                return None

            if self._user_id:
                if not await self.permissions.can_read_node(node_id):
                    return None

            return self._row_to_node(row)

    async def get_by_ids(self, node_ids: List[int]) -> List[Node]:
        """Get multiple nodes by internal IDs in a single query."""
        if not node_ids:
            return []

        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node WHERE id = ANY($1) AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
                node_ids, self._workspace_id,
            )
            return [self._row_to_node(row) for row in rows]

    async def get_by_uuid(self, uuid: str) -> Optional[Node]:
        """Get node by UUID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT * FROM node WHERE uuid = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
                uuid, self._workspace_id,
            )
            if not row:
                return None

            if self._user_id:
                if not await self.permissions.can_read_node(row["id"]):
                    return None

            return self._row_to_node(row)

    async def get_by_uuids(self, uuids: list) -> list:
        """Get multiple nodes by UUID in a single query."""
        if not uuids:
            return []
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node WHERE uuid = ANY($1) AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
                uuids, self._workspace_id,
            )
            return [self._row_to_node(row) for row in rows]

    async def update(
        self,
        node_id: int,
        data: NodeUpdateData,
        user_id: Optional[int] = None,
        expected_version: Optional[int] = None,
    ) -> Optional[Node]:
        """Update a node with optimistic locking support."""
        if self._user_id:
            await self.permissions.require_node_write(node_id)

        now = utc_now()
        uid = user_id or self._user_id

        set_clauses = ["version = version + 1", "write_date = $1", "write_uid = $2"]
        params: List[Any] = [now, uid]
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
            if await self._is_page(data.parent_id):
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
                "is_class": False, "is_page": False, "is_day": False,
                "is_month": False, "is_year": False, "is_asset": False,
                "is_template": False, "is_comment": False,
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

        if expected_version is not None:
            where_clause += f" AND version = ${param_idx}"
            params.append(expected_version)

        query = f"""
            UPDATE node
            SET {", ".join(set_clauses)}
            WHERE {where_clause}
            RETURNING *
        """

        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(query, *params)

            if row is None and expected_version is not None:
                check_row = await conn.fetchrow(
                    "SELECT version FROM node WHERE id = $1 AND workspace_id = $2",
                    node_id, self._workspace_id,
                )
                if check_row:
                    raise OptimisticLockError(
                        node_id=node_id,
                        expected_version=expected_version,
                        actual_version=check_row["version"],
                    )

            return self._row_to_node(row) if row else None

    async def delete(self, node_id: int) -> bool:
        """Delete a node and all its children (soft delete)."""
        if self._user_id:
            await self.permissions.require_node_delete(node_id)

        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT np.descendant_id as id
                FROM node_path np
                JOIN node n ON n.id = np.descendant_id
                WHERE np.ancestor_id = $1 AND n.workspace_id = $2
            """, node_id, self._workspace_id)

            if not rows:
                return False

            ids_to_delete = [row["id"] for row in rows]
            now = utc_now()
            await conn.execute("""
                UPDATE node SET active = FALSE, write_date = $1, write_uid = $2
                WHERE id = ANY($3) AND workspace_id = $4
            """, now, self._user_id, ids_to_delete, self._workspace_id)

            return True

    async def hard_delete(self, node_id: int) -> bool:
        """Permanently delete a node and all its children."""
        from app.logging_config import get_logger
        logger = get_logger(__name__)

        if self._user_id:
            await self.permissions.require_node_delete(node_id)

        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT np.descendant_id as id
                FROM node_path np
                JOIN node n ON n.id = np.descendant_id
                WHERE np.ancestor_id = $1 AND n.workspace_id = $2
            """, node_id, self._workspace_id)

            logger.info(f"[HARD_DELETE] node_id={node_id}, workspace_id={self._workspace_id}, found {len(rows)} descendants in node_path")

            if not rows:
                logger.info("[HARD_DELETE] No node_path entries, trying direct delete")
                result = await conn.execute(
                    "DELETE FROM node WHERE id = $1 AND workspace_id = $2",
                    node_id, self._workspace_id,
                )
                logger.info(f"[HARD_DELETE] Direct delete result: {result}")
                return "DELETE 1" in result

            ids_to_delete = [row["id"] for row in rows]
            logger.info(f"[HARD_DELETE] Deleting node ids: {ids_to_delete}")

            result = await conn.execute(
                "DELETE FROM node WHERE id = ANY($1) AND workspace_id = $2",
                ids_to_delete, self._workspace_id,
            )
            logger.info(f"[HARD_DELETE] Delete result: {result}")
            return True

    async def get_children(self, parent_id: int) -> List[Node]:
        """Get direct children of a node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node WHERE parent_id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE ORDER BY sequence",
                parent_id, self._workspace_id,
            )
            return [self._row_to_node(row) for row in rows]

    async def get_page_content(self, page_id: int) -> List[Node]:
        """Get all nodes belonging to a page (recursive children)."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT * FROM node
                WHERE (page_id = $1 OR id = $1) AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE
                ORDER BY sequence
            """, page_id, self._workspace_id)
            return [self._row_to_node(row) for row in rows]

    async def set_active(
        self, node_id: int, active: bool, user_id: Optional[int] = None
    ) -> Optional[Node]:
        """Set the active status of a node (archive/unarchive)."""
        if self._user_id:
            await self.permissions.require_node_write(node_id)

        now = utc_now()
        uid = user_id or self._user_id
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow("""
                UPDATE node
                SET active = $1, write_date = $2, write_uid = $3, version = version + 1
                WHERE id = $4 AND workspace_id = $5
                RETURNING *
            """, active, now, uid, node_id, self._workspace_id)
            return self._row_to_node(row) if row else None

    async def update_open_date(self, node_id: int) -> Optional[Node]:
        """Update the open_date timestamp for a node."""
        now = utc_now()
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow("""
                UPDATE node
                SET open_date = $1
                WHERE id = $2 AND workspace_id = $3
                RETURNING *
            """, now, node_id, self._workspace_id)
            return self._row_to_node(row) if row else None
