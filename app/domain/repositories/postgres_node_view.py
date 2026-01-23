"""PostgreSQL implementation of NodeView repository."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional, List, Any, Dict, TYPE_CHECKING

import asyncpg
from asyncpg import Connection
from asyncpg.pool import PoolConnectionProxy

from ..entities import NodeView, generate_uuid
from ...logging_config import get_logger
from ...db.schema.constants import DEFAULT_QUERY_BLOCK_TREE
from .base import normalize_timestamp
from ...utils import utc_now

if TYPE_CHECKING:
    pass

logger = get_logger(__name__)


class PostgresNodeViewRepository:
    """PostgreSQL implementation for NodeView CRUD operations.
    
    NodeViews store references to query nodes that define dynamic collections.
    Each node can have multiple views per view_type, displayed as tabs.
    """
    
    def __init__(
        self, 
        pool: asyncpg.Pool,
        graph_id: int,
        user_id: Optional[str] = None
    ):
        """Initialize with connection pool and graph context.
        
        Args:
            pool: asyncpg connection pool
            graph_id: Current graph ID for multi-tenant queries
            user_id: Current user ID (string) for audit fields
        """
        self._pool = pool
        self._graph_id = graph_id
        self._user_id = user_id
    
    def _row_to_node_view(self, row: asyncpg.Record) -> NodeView:
        """Convert database row to NodeView entity."""
        create_date = row['create_date']
        write_date = row['write_date']
        
        if isinstance(create_date, datetime):
            create_date = create_date.isoformat()
        if isinstance(write_date, datetime):
            write_date = write_date.isoformat()
        
        # Parse query_json from JSONB
        query_json = row.get('query_json')
        if query_json is None:
            query_json = DEFAULT_QUERY_BLOCK_TREE.copy()
        elif isinstance(query_json, str):
            try:
                query_json = json.loads(query_json)
            except json.JSONDecodeError:
                query_json = DEFAULT_QUERY_BLOCK_TREE.copy()
        
        return NodeView(
            id=row['id'],
            uuid=str(row['uuid']),
            node_id=row['node_id'],
            name=row['name'],
            query_json=query_json,
            view_type=row['view_type'],
            order_index=row.get('order_index', 0),
            is_default=row.get('is_default', False),
            active=row.get('active', True),
            create_date=create_date,
            write_date=write_date,
            create_uid=row.get('create_uid'),
            write_uid=row.get('write_uid'),
        )
    
    async def create(
        self,
        node_id: int,
        name: str,
        view_type: str,
        query_json: Optional[Dict[str, Any]] = None,
        order_index: int = 0,
        is_default: bool = False,
    ) -> NodeView:
        """Create a new NodeView.
        
        Args:
            node_id: The node this view belongs to
            name: Display name for the tab
            view_type: e.g., child_pages, typed_nodes, linked_references
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
            query_json = DEFAULT_QUERY_BLOCK_TREE.copy()
        
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                INSERT INTO node_view (
                    uuid, node_id, name, query_json, view_type, 
                    order_index, is_default, active,
                    create_date, write_date, create_uid, write_uid
                )
                VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, TRUE, $8, $8, $9, $9)
                RETURNING *
            """, uuid, node_id, name, json.dumps(query_json), view_type,
                order_index, is_default, now, self._user_id)
            
            if not row:
                raise RuntimeError(f"Failed to create NodeView for node {node_id}")
            
            return self._row_to_node_view(row)
    
    async def get_by_id(self, view_id: int) -> Optional[NodeView]:
        """Get a NodeView by ID."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                SELECT nv.* FROM node_view nv
                JOIN node n ON n.id = nv.node_id
                WHERE nv.id = $1 AND nv.active = TRUE
                  AND n.graph_id = $2
            """, view_id, self._graph_id)
            
            if not row:
                return None
            return self._row_to_node_view(row)
    
    async def get_by_uuid(self, uuid: str) -> Optional[NodeView]:
        """Get a NodeView by UUID."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                SELECT nv.* FROM node_view nv
                JOIN node n ON n.id = nv.node_id
                WHERE nv.uuid = $1 AND nv.active = TRUE
                  AND n.graph_id = $2
            """, uuid, self._graph_id)
            
            if not row:
                return None
            return self._row_to_node_view(row)
    
    async def list_by_node(
        self,
        node_id: int,
        view_type: Optional[str] = None,
        include_inactive: bool = False,
    ) -> List[NodeView]:
        """List NodeViews for a node.
        
        Args:
            node_id: The node ID
            view_type: Optional filter by view_type
            include_inactive: Whether to include inactive views
            
        Returns:
            List of NodeViews sorted by order_index
        """
        async with self._pool.acquire() as conn:
            params: list[Any] = [node_id, self._graph_id]
            where_clauses = ["nv.node_id = $1", "n.graph_id = $2"]
            
            if not include_inactive:
                where_clauses.append("nv.active = TRUE")
            
            if view_type:
                params.append(view_type)
                where_clauses.append(f"nv.view_type = ${len(params)}")
            
            where_sql = " AND ".join(where_clauses)
            
            rows = await conn.fetch(f"""
                SELECT nv.* FROM node_view nv
                JOIN node n ON n.id = nv.node_id
                WHERE {where_sql}
                ORDER BY nv.view_type, nv.order_index, nv.create_date
            """, *params)
            
            return [self._row_to_node_view(row) for row in rows]
    
    async def list_by_view_type(
        self,
        node_id: int,
        view_type: str,
    ) -> List[NodeView]:
        """List NodeViews for a specific view_type.
        
        Args:
            node_id: The node ID
            view_type: The view type to filter by
            
        Returns:
            List of NodeViews sorted by order_index
        """
        return await self.list_by_node(node_id, view_type=view_type)
    
    async def get_default_view(
        self,
        node_id: int,
        view_type: str,
    ) -> Optional[NodeView]:
        """Get the default NodeView for a view_type.
        
        Returns the view marked as default, or the one with lowest order_index.
        
        Args:
            node_id: The node ID
            view_type: The view type
            
        Returns:
            Default NodeView or None
        """
        async with self._pool.acquire() as conn:
            # First try to get explicitly marked default
            row = await conn.fetchrow("""
                SELECT nv.* FROM node_view nv
                JOIN node n ON n.id = nv.node_id
                WHERE nv.node_id = $1 AND nv.view_type = $2
                  AND nv.is_default = TRUE AND nv.active = TRUE
                  AND n.graph_id = $3
                ORDER BY nv.order_index
                LIMIT 1
            """, node_id, view_type, self._graph_id)
            
            if row:
                return self._row_to_node_view(row)
            
            # Fall back to lowest order_index
            row = await conn.fetchrow("""
                SELECT nv.* FROM node_view nv
                JOIN node n ON n.id = nv.node_id
                WHERE nv.node_id = $1 AND nv.view_type = $2
                  AND nv.active = TRUE
                  AND n.graph_id = $3
                ORDER BY nv.order_index
                LIMIT 1
            """, node_id, view_type, self._graph_id)
            
            if row:
                return self._row_to_node_view(row)
            
            return None
    
    async def update(
        self,
        view_id: int,
        name: Optional[str] = None,
        order_index: Optional[int] = None,
        is_default: Optional[bool] = None,
    ) -> Optional[NodeView]:
        """Update a NodeView.
        
        Args:
            view_id: The view ID
            name: New display name
            order_index: New order index
            is_default: New default flag
            
        Returns:
            Updated NodeView or None if not found
        """
        updates = []
        params: list[Any] = [view_id, self._graph_id]
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
        
        if not updates:
            return await self.get_by_id(view_id)
        
        # Add write_uid if available
        if self._user_id:
            param_idx += 1
            updates.append(f"write_uid = ${param_idx}")
            params.append(self._user_id)
        
        updates_sql = ", ".join(updates)
        
        async with self._pool.acquire() as conn:
            # If setting as default, unset other defaults for same view_type
            if is_default:
                await conn.execute("""
                    UPDATE node_view nv
                    SET is_default = FALSE, write_uid = $3
                    FROM node_view nv2
                    JOIN node n ON n.id = nv2.node_id
                    WHERE nv.node_id = nv2.node_id
                      AND nv.view_type = nv2.view_type
                      AND nv2.id = $1
                      AND nv.id != $1
                      AND n.graph_id = $2
                """, view_id, self._graph_id, self._user_id)
            
            row = await conn.fetchrow(f"""
                UPDATE node_view nv
                SET {updates_sql}, write_date = NOW()
                FROM node n
                WHERE nv.id = $1 AND n.id = nv.node_id AND n.graph_id = $2
                RETURNING nv.*
            """, *params)
            
            if not row:
                return None
            return self._row_to_node_view(row)
    
    async def update_query_json(
        self,
        view_id: int,
        query_json: Dict[str, Any],
    ) -> Optional[NodeView]:
        """Update a NodeView's query JSON.
        
        Args:
            view_id: The view ID
            query_json: New query block tree JSON
            
        Returns:
            Updated NodeView or None if not found
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                UPDATE node_view nv
                SET query_json = $3::jsonb, write_date = NOW(), write_uid = $4
                FROM node n
                WHERE nv.id = $1 AND n.id = nv.node_id AND n.graph_id = $2
                RETURNING nv.*
            """, view_id, self._graph_id, json.dumps(query_json), self._user_id)
            
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
        async with self._pool.acquire() as conn:
            result = await conn.execute("""
                UPDATE node_view nv
                SET active = FALSE, write_date = NOW(), write_uid = $3
                FROM node n
                WHERE nv.id = $1 AND n.id = nv.node_id AND n.graph_id = $2
            """, view_id, self._graph_id, self._user_id)
            
            return "UPDATE 1" in result
    
    async def hard_delete(self, view_id: int) -> bool:
        """Permanently delete a NodeView.
        
        Args:
            view_id: The view ID to delete
            
        Returns:
            True if deleted, False if not found
        """
        async with self._pool.acquire() as conn:
            result = await conn.execute("""
                DELETE FROM node_view nv
                USING node n
                WHERE nv.id = $1 AND n.id = nv.node_id AND n.graph_id = $2
            """, view_id, self._graph_id)
            
            return "DELETE 1" in result
    
    async def reorder(
        self,
        node_id: int,
        view_type: str,
        view_ids: List[int],
    ) -> List[NodeView]:
        """Reorder NodeViews within a view_type.
        
        Args:
            node_id: The node ID
            view_type: The view type
            view_ids: List of view IDs in desired order
            
        Returns:
            Updated list of NodeViews
        """
        async with self._pool.acquire() as conn:
            for idx, view_id in enumerate(view_ids):
                await conn.execute("""
                    UPDATE node_view nv
                    SET order_index = $1, write_date = NOW(), write_uid = $5
                    FROM node n
                    WHERE nv.id = $2 AND nv.node_id = $3 AND nv.view_type = $4
                      AND n.id = nv.node_id AND n.graph_id = $6
                """, idx, view_id, node_id, view_type, self._user_id, self._graph_id)
        
        return await self.list_by_view_type(node_id, view_type)
    
    async def count_by_node(self, node_id: int) -> int:
        """Count active NodeViews for a node.
        
        Args:
            node_id: The node ID
            
        Returns:
            Count of active views
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                SELECT COUNT(*) as count FROM node_view nv
                JOIN node n ON n.id = nv.node_id
                WHERE nv.node_id = $1 AND nv.active = TRUE AND n.graph_id = $2
            """, node_id, self._graph_id)
            
            return row['count'] if row else 0
