"""PostgreSQL implementation of Node repository."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional, List, Any, TYPE_CHECKING

import asyncpg

from ..entities import Node, NodeCreateData, NodeUpdateData, generate_uuid
from ..errors import OptimisticLockError
from .interfaces import NodeRepository

if TYPE_CHECKING:
    pass


def utc_now() -> datetime:
    """Get current UTC datetime."""
    return datetime.now(timezone.utc)


class PostgresNodeRepository(NodeRepository):
    """PostgreSQL implementation of the NodeRepository.
    
    Supports:
    - Multi-tenant workspaces
    - Optimistic locking via version column
    - Full-text search
    - Hierarchical queries with CTEs
    """
    
    def __init__(
        self, 
        pool: asyncpg.Pool,
        workspace_id: int,
        page_type_id: int,
        types_property_id: int
    ):
        """Initialize with connection pool and workspace context.
        
        Args:
            pool: asyncpg connection pool
            workspace_id: Current workspace ID for multi-tenant queries
            page_type_id: ID of the 'page' type node
            types_property_id: ID of the 'types' property
        """
        self._pool = pool
        self._workspace_id = workspace_id
        self._page_type_id = page_type_id
        self._types_property_id = types_property_id
    
    def get_connection(self) -> asyncpg.Pool:
        """Get the underlying connection pool."""
        return self._pool
    
    def row_to_node(self, row: asyncpg.Record) -> Node:
        """Convert database row to Node entity (public interface)."""
        return self._row_to_node(row)
    
    def _row_to_node(self, row: asyncpg.Record) -> Node:
        """Convert database row to Node entity."""
        # Parse JSONB types_path
        types_path = row.get('types_path', [])
        if types_path is None:
            types_path = []
        elif isinstance(types_path, str):
            try:
                types_path = json.loads(types_path)
            except (json.JSONDecodeError, TypeError):
                types_path = []
        
        # Convert timestamps to ISO strings if they're datetime objects
        create_date = row['create_date']
        write_date = row['write_date']
        open_date = row.get('open_date')
        
        if isinstance(create_date, datetime):
            create_date = create_date.isoformat()
        if isinstance(write_date, datetime):
            write_date = write_date.isoformat()
        if isinstance(open_date, datetime):
            open_date = open_date.isoformat()
        
        return Node(
            id=row['id'],
            uuid=str(row['uuid']),
            name=row['name'],
            icon=row.get('icon'),
            color=row.get('color'),
            parent_id=row.get('parent_id'),
            page_id=row.get('page_id'),
            sequence=row.get('sequence', 0),
            collapsed=row.get('collapsed', False),
            active=row.get('active', True),
            is_type=row.get('is_type', False),
            is_page=row.get('is_page', False),
            is_day=row.get('is_day', False),
            is_month=row.get('is_month', False),
            is_year=row.get('is_year', False),
            is_asset=row.get('is_asset', False),
            is_template=row.get('is_template', False),
            is_comment=row.get('is_comment', False),
            usable_in=row.get('usable_in', 'both'),
            open_date=open_date,
            create_date=create_date,
            write_date=write_date,
            create_uid=row.get('create_uid'),
            write_uid=row.get('write_uid'),
            types_path=types_path,
            version=row.get('version', 1),
        )
    
    async def _compute_page_id(self, parent_id: int) -> Optional[int]:
        """Walk up parent chain to find containing page using recursive CTE."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id, is_page, 1 as depth
                    FROM node 
                    WHERE id = $1 AND workspace_id = $2
                    UNION ALL
                    SELECT n.id, n.parent_id, n.is_page, a.depth + 1
                    FROM node n
                    JOIN ancestors a ON n.id = a.parent_id
                    WHERE n.workspace_id = $2 AND a.depth < 100
                )
                SELECT id FROM ancestors 
                WHERE is_page = TRUE 
                ORDER BY depth ASC
                LIMIT 1
            """, parent_id, self._workspace_id)
            return row['id'] if row else None
    
    async def _is_page(self, node_id: int) -> bool:
        """Check if a node is a page."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT is_page FROM node WHERE id = $1 AND workspace_id = $2",
                node_id, self._workspace_id
            )
            return row['is_page'] if row else False
    
    async def _shift_siblings_for_insert(self, conn: asyncpg.Connection, parent_id: int, sequence: int) -> None:
        """Shift siblings at or after the given sequence to make room for insertion."""
        await conn.execute("""
            UPDATE node SET sequence = sequence + 1 
            WHERE parent_id = $1 AND sequence >= $2 AND workspace_id = $3
        """, parent_id, sequence, self._workspace_id)
    
    async def _close_sequence_gap(self, conn: asyncpg.Connection, parent_id: int, old_sequence: int) -> None:
        """Close the gap left by a node that moved away."""
        await conn.execute("""
            UPDATE node SET sequence = sequence - 1 
            WHERE parent_id = $1 AND sequence > $2 AND workspace_id = $3
        """, parent_id, old_sequence, self._workspace_id)
    
    async def move(
        self,
        node_id: int,
        new_parent_id: int,
        new_sequence: int,
        user_id: Optional[int] = None
    ) -> Optional[Node]:
        """Move a node to a new parent and/or position with proper sibling resequencing."""
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                node = await self.get_by_id(node_id)
                if not node:
                    return None
                
                old_parent_id = node.parent_id
                old_sequence = node.sequence
                now = utc_now()
                
                # Compute new page_id
                if await self._is_page(new_parent_id):
                    new_page_id = new_parent_id
                else:
                    new_page_id = await self._compute_page_id(new_parent_id)
                
                # Same parent - just resequence
                if old_parent_id == new_parent_id:
                    if old_sequence == new_sequence:
                        return node
                    
                    if old_sequence < new_sequence:
                        await conn.execute("""
                            UPDATE node SET sequence = sequence - 1 
                            WHERE parent_id = $1 AND sequence > $2 AND sequence <= $3 
                            AND id != $4 AND workspace_id = $5
                        """, new_parent_id, old_sequence, new_sequence, node_id, self._workspace_id)
                    else:
                        await conn.execute("""
                            UPDATE node SET sequence = sequence + 1 
                            WHERE parent_id = $1 AND sequence >= $2 AND sequence < $3 
                            AND id != $4 AND workspace_id = $5
                        """, new_parent_id, new_sequence, old_sequence, node_id, self._workspace_id)
                else:
                    if old_parent_id is not None:
                        await self._close_sequence_gap(conn, old_parent_id, old_sequence)
                    await self._shift_siblings_for_insert(conn, new_parent_id, new_sequence)
                
                # Update the node
                await conn.execute("""
                    UPDATE node 
                    SET parent_id = $1, page_id = $2, sequence = $3, 
                        write_date = $4, write_uid = $5, version = version + 1
                    WHERE id = $6 AND workspace_id = $7
                """, new_parent_id, new_page_id, new_sequence, now, user_id, node_id, self._workspace_id)
                
                return await self.get_by_id(node_id)
    
    async def create(self, data: NodeCreateData, user_id: Optional[int] = None) -> Node:
        """Create a new node."""
        now = utc_now()
        uuid = generate_uuid()
        
        # Compute page_id for blocks
        page_id = None
        if data.parent_id:
            if await self._is_page(data.parent_id):
                page_id = data.parent_id
            else:
                page_id = await self._compute_page_id(data.parent_id)
        
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                # Shift siblings if inserting at specific position
                if data.parent_id is not None and data.sequence is not None:
                    await self._shift_siblings_for_insert(conn, data.parent_id, data.sequence)
                
                # Insert node
                row = await conn.fetchrow("""
                    INSERT INTO node (
                        uuid, workspace_id, name, icon, color, parent_id, page_id,
                        sequence, collapsed,
                        is_type, is_page, is_day, is_month, is_year,
                        is_asset, is_template, is_comment, usable_in,
                        create_date, write_date, create_uid, write_uid
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19, $20, $20)
                    RETURNING id
                """, uuid, self._workspace_id, data.name, data.icon, data.color,
                    data.parent_id, page_id, data.sequence, data.collapsed,
                    data.is_type, data.is_page, data.is_day,
                    data.is_month, data.is_year, data.is_asset,
                    data.is_template, data.is_comment, data.usable_in,
                    now, user_id)
                
                node_id = row['id']
                
                # Add types as property values
                if data.types:
                    await conn.execute("""
                        INSERT INTO node_property (node_id, property_id, create_date, write_date)
                        VALUES ($1, $2, $3, $3)
                        ON CONFLICT (node_id, property_id) DO NOTHING
                    """, node_id, self._types_property_id, now)
                    
                    np_row = await conn.fetchrow(
                        "SELECT id FROM node_property WHERE node_id = $1 AND property_id = $2",
                        node_id, self._types_property_id
                    )
                    if not np_row:
                        raise RuntimeError(f"Failed to create node_property for node {node_id}")
                    node_property_id = np_row['id']
                    
                    for seq, type_id in enumerate(data.types):
                        await conn.execute("""
                            INSERT INTO property_value_relation 
                            (node_property_id, property_id, node_id, target_node_id, "order", create_date, write_date)
                            VALUES ($1, $2, $3, $4, $5, $6, $6)
                        """, node_property_id, self._types_property_id, node_id, type_id, seq, now)
        
        return Node(
            id=node_id,
            uuid=uuid,
            name=data.name,
            icon=data.icon,
            color=data.color,
            parent_id=data.parent_id,
            page_id=page_id,
            sequence=data.sequence,
            collapsed=data.collapsed,
            active=True,
            is_type=data.is_type,
            is_page=data.is_page,
            is_day=data.is_day,
            is_month=data.is_month,
            is_year=data.is_year,
            is_asset=data.is_asset,
            is_template=data.is_template,
            is_comment=data.is_comment,
            usable_in=data.usable_in,
            create_date=now.isoformat(),
            write_date=now.isoformat(),
            create_uid=user_id,
            write_uid=user_id,
            version=1,
        )
    
    async def create_with_uuid(
        self,
        uuid: str,
        data: NodeCreateData,
        user_id: Optional[int] = None
    ) -> Node:
        """Create a new node with a specific UUID (for date nodes)."""
        now = utc_now()
        
        # Compute page_id for blocks
        page_id = None
        if data.parent_id:
            if await self._is_page(data.parent_id):
                page_id = data.parent_id
            else:
                page_id = await self._compute_page_id(data.parent_id)
        
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow("""
                    INSERT INTO node (
                        uuid, workspace_id, name, icon, color, parent_id, page_id,
                        sequence, collapsed,
                        is_type, is_page, is_day, is_month, is_year,
                        is_asset, is_template, is_comment, usable_in,
                        create_date, write_date, create_uid, write_uid
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19, $20, $20)
                    RETURNING id
                """, uuid, self._workspace_id, data.name, data.icon, data.color,
                    data.parent_id, page_id, data.sequence, data.collapsed,
                    data.is_type, data.is_page, data.is_day,
                    data.is_month, data.is_year, data.is_asset,
                    data.is_template, data.is_comment, data.usable_in,
                    now, user_id)
                
                node_id = row['id']
                
                # Add types
                if data.types:
                    await conn.execute("""
                        INSERT INTO node_property (node_id, property_id, create_date, write_date)
                        VALUES ($1, $2, $3, $3)
                        ON CONFLICT (node_id, property_id) DO NOTHING
                    """, node_id, self._types_property_id, now)
                    
                    np_row = await conn.fetchrow(
                        "SELECT id FROM node_property WHERE node_id = $1 AND property_id = $2",
                        node_id, self._types_property_id
                    )
                    if not np_row:
                        raise RuntimeError(f"Failed to create node_property for node {node_id}")
                    node_property_id = np_row['id']
                    
                    for seq, type_id in enumerate(data.types):
                        await conn.execute("""
                            INSERT INTO property_value_relation 
                            (node_property_id, property_id, node_id, target_node_id, "order", create_date, write_date)
                            VALUES ($1, $2, $3, $4, $5, $6, $6)
                        """, node_property_id, self._types_property_id, node_id, type_id, seq, now)
        
        return Node(
            id=node_id,
            uuid=uuid,
            name=data.name,
            icon=data.icon,
            color=data.color,
            parent_id=data.parent_id,
            page_id=page_id,
            sequence=data.sequence,
            collapsed=data.collapsed,
            active=True,
            is_type=data.is_type,
            is_page=data.is_page,
            is_day=data.is_day,
            is_month=data.is_month,
            is_year=data.is_year,
            is_asset=data.is_asset,
            is_template=data.is_template,
            is_comment=data.is_comment,
            usable_in=data.usable_in,
            create_date=now.isoformat(),
            write_date=now.isoformat(),
            create_uid=user_id,
            write_uid=user_id,
            version=1,
        )
    
    async def get_by_id(self, node_id: int) -> Optional[Node]:
        """Get node by internal ID."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM node WHERE id = $1 AND workspace_id = $2",
                node_id, self._workspace_id
            )
            return self._row_to_node(row) if row else None
    
    async def get_by_uuid(self, uuid: str) -> Optional[Node]:
        """Get node by UUID."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM node WHERE uuid = $1 AND workspace_id = $2",
                uuid, self._workspace_id
            )
            return self._row_to_node(row) if row else None
    
    async def update(
        self,
        node_id: int,
        data: NodeUpdateData,
        user_id: Optional[int] = None,
        expected_version: Optional[int] = None
    ) -> Optional[Node]:
        """Update a node with optimistic locking support.
        
        Args:
            node_id: Node to update
            data: Update data
            user_id: User making the change
            expected_version: If provided, update only if version matches
            
        Raises:
            OptimisticLockError: If version doesn't match
        """
        now = utc_now()
        
        # Build update query dynamically
        set_clauses = ["version = version + 1", "write_date = $1", "write_uid = $2"]
        params: List[Any] = [now, user_id]
        param_idx = 3
        
        if data.name is not None:
            set_clauses.append(f"name = ${param_idx}")
            params.append(data.name)
            param_idx += 1
        
        if data.icon is not None:
            set_clauses.append(f"icon = ${param_idx}")
            params.append(data.icon)
            param_idx += 1
        elif data.clear_icon:
            set_clauses.append(f"icon = NULL")
        
        if data.color is not None:
            set_clauses.append(f"color = ${param_idx}")
            params.append(data.color)
            param_idx += 1
        elif data.clear_color:
            set_clauses.append(f"color = NULL")
        
        if data.parent_id is not None:
            set_clauses.append(f"parent_id = ${param_idx}")
            params.append(data.parent_id)
            param_idx += 1
            # Recompute page_id
            if await self._is_page(data.parent_id):
                page_id = data.parent_id
            else:
                page_id = await self._compute_page_id(data.parent_id)
            set_clauses.append(f"page_id = ${param_idx}")
            params.append(page_id)
            param_idx += 1
        
        if data.sequence is not None:
            set_clauses.append(f"sequence = ${param_idx}")
            params.append(data.sequence)
            param_idx += 1
        
        if data.collapsed is not None:
            set_clauses.append(f"collapsed = ${param_idx}")
            params.append(data.collapsed)
            param_idx += 1
        
        # Type flags
        for flag in ['is_type', 'is_page', 'is_day', 'is_month', 'is_year', 
                     'is_asset', 'is_template', 'is_comment']:
            value = getattr(data, flag, None)
            if value is not None:
                set_clauses.append(f"{flag} = ${param_idx}")
                params.append(value)
                param_idx += 1
        
        if data.usable_in is not None:
            set_clauses.append(f"usable_in = ${param_idx}")
            params.append(data.usable_in)
            param_idx += 1
        
        # Build WHERE clause
        where_clause = f"id = ${param_idx} AND workspace_id = ${param_idx + 1}"
        params.append(node_id)
        params.append(self._workspace_id)
        param_idx += 2
        
        if expected_version is not None:
            where_clause += f" AND version = ${param_idx}"
            params.append(expected_version)
        
        query = f"""
            UPDATE node 
            SET {', '.join(set_clauses)}
            WHERE {where_clause}
            RETURNING *
        """
        
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(query, *params)
            
            if row is None and expected_version is not None:
                # Check if node exists with different version
                check_row = await conn.fetchrow(
                    "SELECT version FROM node WHERE id = $1 AND workspace_id = $2",
                    node_id, self._workspace_id
                )
                if check_row:
                    raise OptimisticLockError(
                        node_id=node_id,
                        expected_version=expected_version,
                        actual_version=check_row['version']
                    )
            
            return self._row_to_node(row) if row else None
    
    async def delete(self, node_id: int) -> bool:
        """Delete a node and all its children."""
        async with self._pool.acquire() as conn:
            # Use recursive CTE to get all descendants
            rows = await conn.fetch("""
                WITH RECURSIVE descendants AS (
                    SELECT id FROM node WHERE id = $1 AND workspace_id = $2
                    UNION ALL
                    SELECT n.id FROM node n
                    JOIN descendants d ON n.parent_id = d.id
                    WHERE n.workspace_id = $2
                )
                SELECT id FROM descendants
            """, node_id, self._workspace_id)
            
            if not rows:
                return False
            
            ids_to_delete = [row['id'] for row in rows]
            
            # Delete all nodes (cascades to property values, links)
            await conn.execute(
                "DELETE FROM node WHERE id = ANY($1) AND workspace_id = $2",
                ids_to_delete, self._workspace_id
            )
            
            return True
    
    async def get_children(self, parent_id: int) -> List[Node]:
        """Get direct children of a node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM node WHERE parent_id = $1 AND workspace_id = $2 ORDER BY sequence",
                parent_id, self._workspace_id
            )
            return [self._row_to_node(row) for row in rows]
    
    async def get_all_pages(self) -> List[Node]:
        """Get all active nodes tagged as 'page'."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT * FROM node
                WHERE is_page = TRUE AND active = TRUE AND workspace_id = $1
                ORDER BY write_date DESC
            """, self._workspace_id)
            return [self._row_to_node(row) for row in rows]
    
    async def get_page_content(self, page_id: int) -> List[Node]:
        """Get all nodes belonging to a page (recursive children)."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT * FROM node 
                WHERE (page_id = $1 OR id = $1) AND workspace_id = $2
                ORDER BY sequence
            """, page_id, self._workspace_id)
            return [self._row_to_node(row) for row in rows]
    
    async def search(self, query: str, limit: int = 50) -> List[Node]:
        """Search nodes by name using full-text search."""
        async with self._pool.acquire() as conn:
            # Use FTS if query is substantial, fall back to ILIKE for short queries
            if len(query) >= 3:
                rows = await conn.fetch("""
                    SELECT *, ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
                    FROM node
                    WHERE workspace_id = $2 
                    AND (search_vector @@ plainto_tsquery('english', $1) OR name ILIKE $3)
                    ORDER BY rank DESC, write_date DESC
                    LIMIT $4
                """, query, self._workspace_id, f'%{query}%', limit)
            else:
                rows = await conn.fetch(
                    "SELECT * FROM node WHERE name ILIKE $1 AND workspace_id = $2 LIMIT $3",
                    f'%{query}%', self._workspace_id, limit
                )
            return [self._row_to_node(row) for row in rows]
    
    async def get_typed_with(self, type_node_id: int) -> List[Node]:
        """Get all nodes with a specific type."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT n.* FROM node n
                JOIN property_value_relation pvr ON n.id = pvr.node_id
                WHERE pvr.property_id = $1 AND pvr.target_node_id = $2 AND n.workspace_id = $3
            """, self._types_property_id, type_node_id, self._workspace_id)
            return [self._row_to_node(row) for row in rows]
    
    async def set_active(self, node_id: int, active: bool, user_id: Optional[int] = None) -> Optional[Node]:
        """Set the active status of a node (archive/unarchive)."""
        now = utc_now()
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                UPDATE node 
                SET active = $1, write_date = $2, write_uid = $3, version = version + 1
                WHERE id = $4 AND workspace_id = $5
                RETURNING *
            """, active, now, user_id, node_id, self._workspace_id)
            return self._row_to_node(row) if row else None
    
    async def get_archived_pages(self) -> List[Node]:
        """Get all archived nodes tagged as 'page'."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT * FROM node
                WHERE is_page = TRUE AND active = FALSE AND workspace_id = $1
                ORDER BY write_date DESC
            """, self._workspace_id)
            return [self._row_to_node(row) for row in rows]
    
    async def update_open_date(self, node_id: int) -> Optional[Node]:
        """Update the open_date timestamp for a node."""
        now = utc_now()
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                UPDATE node 
                SET open_date = $1
                WHERE id = $2 AND workspace_id = $3
                RETURNING *
            """, now, node_id, self._workspace_id)
            return self._row_to_node(row) if row else None
