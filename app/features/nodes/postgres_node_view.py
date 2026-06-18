"""PostgreSQL implementation of NodeView repository."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any

import asyncpg

from app.db.connection import acquire_connection
from app.db.schema.constants import DEFAULT_QUERY_AST
from app.domain.entities import NodeView, generate_uuid
from app.features.nodes.port import NodeViewRepository
from app.logging_config import get_logger
from app.utils import utc_now

if TYPE_CHECKING:
    pass

logger = get_logger(__name__)


def _format_param(value: Any, max_length: int = 64) -> Any:
    """Return a log-safe representation of a bound parameter.

    String values are truncated to ``max_length`` to avoid logging potentially
    sensitive user content (node names, search terms, property values, etc.).
    """
    if isinstance(value, str) and len(value) > max_length:
        return value[:max_length] + "..."
    if isinstance(value, (bytes, bytearray)) and len(value) > max_length:
        return f"<bytes:{len(value)}>"
    return value


class PostgresNodeViewRepository(NodeViewRepository):
    """PostgreSQL implementation for NodeView CRUD operations.

    NodeViews store references to query nodes that define dynamic collections.
    Each node can have multiple views per view_type, displayed as tabs.
    """

    def __init__(self, pool: asyncpg.Pool, workspace_id: int, user_id: str | None = None):
        """Initialize with connection pool and workspace context.

        Args:
            pool: asyncpg connection pool
            workspace_id: Current workspace ID for multi-tenant queries
            user_id: Current user ID (string) for audit fields
        """
        self._pool = pool
        self._workspace_id = workspace_id
        # Convert user_id to int for database columns
        self._user_id = int(user_id) if user_id is not None else None

    def _row_to_node_view(self, row: asyncpg.Record) -> NodeView:
        """Convert database row to NodeView entity."""
        create_date = row["create_date"]
        write_date = row["write_date"]

        if isinstance(create_date, datetime):
            create_date = create_date.isoformat()
        if isinstance(write_date, datetime):
            write_date = write_date.isoformat()

        # Parse query_json from JSONB
        query_json = row.get("query_json")
        if query_json is None or not isinstance(query_json, dict):
            query_json = DEFAULT_QUERY_AST.copy()

        # Parse shown_properties from JSONB
        shown_properties = row.get("shown_properties")
        if shown_properties is None or not isinstance(shown_properties, list):
            shown_properties = []

        return NodeView(
            id=row["id"],
            uuid=str(row["uuid"]),
            node_id=row["node_id"],
            name=row["name"],
            query_json=query_json,
            view_type=row["view_type"],
            order_index=row.get("order_index", 0),
            is_default=row.get("is_default", False),
            active=row.get("active", True),
            shown_properties=shown_properties,
            group_by=row.get("group_by"),
            create_date=create_date,
            write_date=write_date,
            create_uid=row.get("create_uid"),
            write_uid=row.get("write_uid"),
        )

    async def create(
        self,
        node_id: int,
        name: str,
        view_type: str,
        query_json: dict[str, Any] | None = None,
        order_index: int = 0,
        is_default: bool = False,
    ) -> NodeView:
        """Create a new NodeView.

        Args:
            node_id: The node this view belongs to
            name: Display name for the tab
            view_type: e.g., child_pages, classed_nodes, linked_references
            query_json: The query block tree JSON
            order_index: Tab order within view_type
            is_default: Whether this is the default tab for the view_type

        Returns:
            Created NodeView entity
        """
        now = utc_now()
        uuid = generate_uuid()

        # Use default if not provided
        if query_json is None:
            query_json = DEFAULT_QUERY_AST.copy()

        async with acquire_connection(self._pool) as conn:
            # Use ON CONFLICT to handle the unique constraint on default views
            # If a default view already exists for this node+view_type, update it fully
            # (including reactivating it if it was soft-deleted)
            logger.info(
                f"[create] Creating view: node_id={node_id}, view_type={view_type}, is_default={is_default}, workspace_id={self._workspace_id}"
            )

            if is_default:
                row = await conn.fetchrow(
                    """
                    INSERT INTO node_view (
                        uuid, node_id, name, query_json, view_type,
                        order_index, is_default, active,
                        create_date, write_date, create_uid, write_uid
                    )
                    VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, TRUE, $8, $8, $9, $9)
                    ON CONFLICT (node_id, view_type) WHERE is_default = TRUE
                    DO UPDATE SET
                        name = EXCLUDED.name,
                        query_json = EXCLUDED.query_json,
                        order_index = EXCLUDED.order_index,
                        active = TRUE,
                        write_date = EXCLUDED.write_date,
                        write_uid = EXCLUDED.write_uid
                    RETURNING *
                """,
                    uuid,
                    node_id,
                    name,
                    query_json,
                    view_type,
                    order_index,
                    is_default,
                    now,
                    self._user_id,
                )
            else:
                row = await conn.fetchrow(
                    """
                    INSERT INTO node_view (
                        uuid, node_id, name, query_json, view_type,
                        order_index, is_default, active,
                        create_date, write_date, create_uid, write_uid
                    )
                    VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, TRUE, $8, $8, $9, $9)
                    RETURNING *
                """,
                    uuid,
                    node_id,
                    name,
                    query_json,
                    view_type,
                    order_index,
                    is_default,
                    now,
                    self._user_id,
                )

            if not row:
                raise RuntimeError(f"Failed to create NodeView for node {node_id}")

            result = self._row_to_node_view(row)
            logger.info(f"[create] Created view id={result.id}, active={result.active}")

            return result

    async def get_by_id(self, view_id: int) -> NodeView | None:
        """Get a NodeView by ID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT nv.* FROM node_view nv
                JOIN node n ON n.id = nv.node_id
                WHERE nv.id = $1 AND nv.active = TRUE
                  AND n.workspace_id = $2
            """,
                view_id,
                self._workspace_id,
            )

            if not row:
                return None
            return self._row_to_node_view(row)

    async def get_by_uuid(self, uuid: str) -> NodeView | None:
        """Get a NodeView by UUID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT nv.* FROM node_view nv
                JOIN node n ON n.id = nv.node_id
                WHERE nv.uuid = $1 AND nv.active = TRUE
                  AND n.workspace_id = $2
            """,
                uuid,
                self._workspace_id,
            )

            if not row:
                return None
            return self._row_to_node_view(row)

    async def list_by_node(
        self,
        node_id: int,
        view_type: str | None = None,
        include_inactive: bool = False,
    ) -> list[NodeView]:
        """List NodeViews for a node.

        Args:
            node_id: The node ID
            view_type: Optional filter by view_type
            include_inactive: Whether to include inactive views

        Returns:
            List of NodeViews sorted by order_index
        """
        async with acquire_connection(self._pool) as conn:
            params: list[Any] = [node_id, self._workspace_id]
            where_clauses = ["nv.node_id = $1", "n.workspace_id = $2"]

            if not include_inactive:
                where_clauses.append("nv.active = TRUE")

            if view_type:
                params.append(view_type)
                where_clauses.append(f"nv.view_type = ${len(params)}")

            where_sql = " AND ".join(where_clauses)

            sql = f"""
                SELECT nv.* FROM node_view nv
                JOIN node n ON n.id = nv.node_id
                WHERE {where_sql}
                ORDER BY nv.view_type, nv.order_index, nv.create_date
            """

            safe_params = [_format_param(p) for p in params]
            logger.debug(f"[list_by_node] SQL: {sql}")
            logger.debug(f"[list_by_node] Params: {safe_params}")

            rows = await conn.fetch(sql, *params)

            logger.info(f"[list_by_node] Found {len(rows)} views")

            return [self._row_to_node_view(row) for row in rows]

    async def list_by_view_type(
        self,
        node_id: int,
        view_type: str,
    ) -> list[NodeView]:
        """List NodeViews for a specific view_type.

        Args:
            node_id: The node ID
            view_type: The view type to filter by

        Returns:
            List of NodeViews sorted by order_index
        """
        return await self.list_by_node(node_id, view_type=view_type)

    async def count_by_view_type(
        self,
        node_id: int,
        view_type: str,
    ) -> int:
        """Count active NodeViews for a specific view_type.

        Args:
            node_id: The node ID
            view_type: The view type to count

        Returns:
            Number of active views of this type
        """
        async with acquire_connection(self._pool) as conn:
            count = await conn.fetchval(
                """
                SELECT COUNT(*) FROM node_view nv
                JOIN node n ON n.id = nv.node_id
                WHERE nv.node_id = $1 AND nv.view_type = $2
                  AND nv.active = TRUE AND n.workspace_id = $3
            """,
                node_id,
                view_type,
                self._workspace_id,
            )
            return count or 0

    async def get_default_view(
        self,
        node_id: int,
        view_type: str,
    ) -> NodeView | None:
        """Get the default NodeView for a view_type.

        Returns the view marked as default, or the one with lowest order_index.

        Args:
            node_id: The node ID
            view_type: The view type

        Returns:
            Default NodeView or None
        """
        async with acquire_connection(self._pool) as conn:
            # First try to get explicitly marked default
            row = await conn.fetchrow(
                """
                SELECT nv.* FROM node_view nv
                JOIN node n ON n.id = nv.node_id
                WHERE nv.node_id = $1 AND nv.view_type = $2
                  AND nv.is_default = TRUE AND nv.active = TRUE
                  AND n.workspace_id = $3
                ORDER BY nv.order_index
                LIMIT 1
            """,
                node_id,
                view_type,
                self._workspace_id,
            )

            if row:
                return self._row_to_node_view(row)

            # Fall back to lowest order_index
            row = await conn.fetchrow(
                """
                SELECT nv.* FROM node_view nv
                JOIN node n ON n.id = nv.node_id
                WHERE nv.node_id = $1 AND nv.view_type = $2
                  AND nv.active = TRUE
                  AND n.workspace_id = $3
                ORDER BY nv.order_index
                LIMIT 1
            """,
                node_id,
                view_type,
                self._workspace_id,
            )

            if row:
                return self._row_to_node_view(row)

            return None

    async def update(
        self,
        view_id: int,
        name: str | None = None,
        order_index: int | None = None,
        is_default: bool | None = None,
        shown_properties: list[dict[str, Any]] | None = None,
        group_by: str | None = None,
    ) -> NodeView | None:
        """Update a NodeView.

        Args:
            view_id: The view ID
            name: New display name
            order_index: New order index
            is_default: New default flag
            shown_properties: New shown properties for table view
            group_by: New group by field for card view

        Returns:
            Updated NodeView or None if not found
        """
        updates = []
        params: list[Any] = [view_id, self._workspace_id]
        param_idx = len(params)

        if name is not None:
            param_idx += 1
            updates.append(f"name = ${param_idx}")
            params.append(name)

        if order_index is not None:
            param_idx += 1
            updates.append(f"order_index = ${param_idx}")
            params.append(order_index)

        if is_default is not None:
            param_idx += 1
            updates.append(f"is_default = ${param_idx}")
            params.append(is_default)

        if shown_properties is not None:
            param_idx += 1
            updates.append(f"shown_properties = ${param_idx}::jsonb")
            params.append(shown_properties)

        if group_by is not None:
            param_idx += 1
            updates.append(f"group_by = ${param_idx}")
            params.append(group_by)

        if not updates:
            return await self.get_by_id(view_id)

        # Add write_uid if available
        if self._user_id:
            param_idx += 1
            updates.append(f"write_uid = ${param_idx}")
            params.append(self._user_id)

        updates_sql = ", ".join(updates)

        async with acquire_connection(self._pool) as conn:
            # If setting as default, unset other defaults for same view_type
            if is_default:
                await conn.execute(
                    """
                    UPDATE node_view nv
                    SET is_default = FALSE, write_uid = $3
                    FROM node_view nv2
                    JOIN node n ON n.id = nv2.node_id
                    WHERE nv.node_id = nv2.node_id
                      AND nv.view_type = nv2.view_type
                      AND nv2.id = $1
                      AND nv.id != $1
                      AND n.workspace_id = $2
                """,
                    view_id,
                    self._workspace_id,
                    self._user_id,
                )

            row = await conn.fetchrow(
                f"""
                UPDATE node_view nv
                SET {updates_sql}, write_date = NOW()
                FROM node n
                WHERE nv.id = $1 AND n.id = nv.node_id AND n.workspace_id = $2
                RETURNING nv.*
            """,
                *params,
            )

            if not row:
                return None
            return self._row_to_node_view(row)

    async def update_query_json(
        self,
        view_id: int,
        query_json: dict[str, Any],
    ) -> NodeView | None:
        """Update a NodeView's query JSON.

        Args:
            view_id: The view ID
            query_json: New query block tree JSON

        Returns:
            Updated NodeView or None if not found
        """
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                UPDATE node_view nv
                SET query_json = $3::jsonb, write_date = NOW(), write_uid = $4
                FROM node n
                WHERE nv.id = $1 AND n.id = nv.node_id AND n.workspace_id = $2
                RETURNING nv.*
            """,
                view_id,
                self._workspace_id,
                query_json,
                self._user_id,
            )

            if not row:
                return None
            return self._row_to_node_view(row)

    async def delete(self, view_id: int) -> bool:
        """Soft delete a NodeView.

        Args:
            view_id: The view ID to delete

        Returns:
            True if deleted, False if not found
        """
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                """
                UPDATE node_view nv
                SET active = FALSE, write_date = NOW(), write_uid = $3
                FROM node n
                WHERE nv.id = $1 AND n.id = nv.node_id AND n.workspace_id = $2
            """,
                view_id,
                self._workspace_id,
                self._user_id,
            )

            return "UPDATE 1" in result

    async def hard_delete(self, view_id: int) -> bool:
        """Permanently delete a NodeView.

        Args:
            view_id: The view ID to delete

        Returns:
            True if deleted, False if not found
        """
        async with acquire_connection(self._pool) as conn:
            logger.info(f"[hard_delete] Deleting view id={view_id}, workspace_id={self._workspace_id}")

            result = await conn.execute(
                """
                DELETE FROM node_view nv
                USING node n
                WHERE nv.id = $1 AND n.id = nv.node_id AND n.workspace_id = $2
            """,
                view_id,
                self._workspace_id,
            )

            success = "DELETE 1" in result
            logger.info(f"[hard_delete] Result: {result}, success={success}")

            return success

    async def reorder(
        self,
        node_id: int,
        view_type: str,
        view_ids: list[int],
    ) -> list[NodeView]:
        """Reorder NodeViews within a view_type.

        Args:
            node_id: The node ID
            view_type: The view type
            view_ids: List of view IDs in desired order

        Returns:
            Updated list of NodeViews
        """
        async with acquire_connection(self._pool) as conn:
            for idx, view_id in enumerate(view_ids):
                await conn.execute(
                    """
                    UPDATE node_view nv
                    SET order_index = $1, write_date = NOW(), write_uid = $5
                    FROM node n
                    WHERE nv.id = $2 AND nv.node_id = $3 AND nv.view_type = $4
                      AND n.id = nv.node_id AND n.workspace_id = $6
                """,
                    idx,
                    view_id,
                    node_id,
                    view_type,
                    self._user_id,
                    self._workspace_id,
                )

        return await self.list_by_view_type(node_id, view_type)

    async def count_by_node(self, node_id: int) -> int:
        """Count active NodeViews for a node.

        Args:
            node_id: The node ID

        Returns:
            Count of active views
        """
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT COUNT(*) as count FROM node_view nv
                JOIN node n ON n.id = nv.node_id
                WHERE nv.node_id = $1 AND nv.active = TRUE AND n.workspace_id = $2
            """,
                node_id,
                self._workspace_id,
            )

            return row["count"] if row else 0
