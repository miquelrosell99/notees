"""PostgreSQL implementation of Link repository.

Updated for graph-based schema:
- node_link table: source_id, target_id (no position, property_id)
- class_inline table: node_id, class_id, position
- All timestamps use create_date
- User tracking via create_uid
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

import asyncpg

from ..entities import NodeLink, InlineClass, InlineType
from .interfaces import LinkRepository
from .base import normalize_timestamp
from ...utils import utc_now


class PostgresLinkRepository(LinkRepository):
    """PostgreSQL implementation of the LinkRepository.
    
    Updated for new schema:
    - source_node_id -> source_id
    - target_node_id -> target_id  
    - Removed: position, property_id fields
    - workspace_id -> graph_id
    - created_at -> create_date
    """
    
    def __init__(self, pool: asyncpg.Pool, graph_id: int, user_id: Optional[int] = None):
        """Initialize with connection pool and graph context.
        
        Args:
            pool: asyncpg connection pool
            graph_id: The graph this repository operates on
            user_id: Optional current user ID for audit trails
        """
        self._pool = pool
        self._graph_id = graph_id
        self._user_id = user_id
    
    def _row_to_link(self, row: asyncpg.Record) -> NodeLink:
        """Convert database row to NodeLink entity."""
        create_date = row['create_date']
        if isinstance(create_date, str):
            create_date = datetime.fromisoformat(create_date)
        return NodeLink(
            id=row['id'],
            source_id=row['source_id'],
            target_id=row['target_id'],
            uuid=str(row['uuid']) if row.get('uuid') else None,
            is_tag=row.get('is_tag', False),
            create_date=create_date,
            create_uid=row.get('create_uid'),
        )
    
    async def create(self, link: NodeLink) -> NodeLink:
        """Create a new link."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                INSERT INTO node_link (source_id, target_id, is_tag, create_date, create_uid, graph_id)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id, uuid
            """, link.source_id, link.target_id, link.is_tag, 
                link.create_date, link.create_uid or self._user_id, self._graph_id)
            
            if row is None:
                raise RuntimeError("Failed to create link - no row returned")
            link.id = row['id']
            link.uuid = str(row['uuid'])
            return link
    
    async def delete_source_links(self, source_node_id: int) -> int:
        """Delete all links from a source node (for re-parsing)."""
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1",
                source_node_id
            )
            # Parse "DELETE n" to get count
            return int(result.split()[-1]) if result else 0
    
    async def get_source_links(self, source_node_id: int) -> List[NodeLink]:
        """Get all links from a source node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE source_id = $1",
                source_node_id
            )
            return [self._row_to_link(row) for row in rows]
    
    async def get_backlinks(self, target_node_id: int) -> List[NodeLink]:
        """Get all links pointing to a target node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE target_id = $1",
                target_node_id
            )
            return [self._row_to_link(row) for row in rows]
    
    async def get_page_backlinks(self, page_id: int) -> List[NodeLink]:
        """Get backlinks with inheritance (links from nodes in this graph)."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT nl.*, n.page_id as source_page_id
                FROM node_link nl
                JOIN node n ON nl.source_id = n.id
                WHERE nl.target_id = $1 AND n.graph_id = $2
            """, page_id, self._graph_id)
            return [self._row_to_link(row) for row in rows]
    
    async def get_outgoing_links(self, source_node_id: int) -> List[NodeLink]:
        """Get all links from a source node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE source_id = $1",
                source_node_id
            )
            return [self._row_to_link(row) for row in rows]
    
    def get_connection(self) -> asyncpg.Pool:
        """Get the underlying connection pool."""
        return self._pool
    
    async def bulk_create(self, links: List[NodeLink]) -> List[NodeLink]:
        """Create multiple links at once using COPY for efficiency."""
        if not links:
            return []
        
        async with self._pool.acquire() as conn:
            # Use copy_records_to_table for best performance
            records = [
                (link.source_id, link.target_id, link.is_tag, 
                 link.create_date, link.create_uid or self._user_id)
                for link in links
            ]
            await conn.copy_records_to_table(
                'node_link',
                records=records,
                columns=['source_id', 'target_id', 'is_tag', 
                        'create_date', 'create_uid']
            )
        
        return links
    
    async def delete_text_links(self, source_node_id: int) -> int:
        """Delete all text links from a source node.
        
        Note: In the new schema, there's no property_id distinction.
        This method now deletes all non-tag links from the source.
        """
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND is_tag = FALSE",
                source_node_id
            )
            return int(result.split()[-1]) if result else 0
    
    async def delete_tag_links(self, source_node_id: int) -> int:
        """Delete all tag links from a source node."""
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND is_tag = TRUE",
                source_node_id
            )
            return int(result.split()[-1]) if result else 0
    
    async def get_backlinks_for_graph(self, target_node_id: int) -> List[NodeLink]:
        """Get backlinks from nodes within the current graph only."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT nl.*
                FROM node_link nl
                JOIN node n ON nl.source_id = n.id
                WHERE nl.target_id = $1 AND n.graph_id = $2
            """, target_node_id, self._graph_id)
            return [self._row_to_link(row) for row in rows]


class PostgresInlineClassRepository:
    """PostgreSQL repository for inline class references.
    
    Updated for new schema:
    - Table renamed from inline_type to type_inline (still used for backwards compat)
    - source_node_id -> node_id
    - type_node_id -> class_id
    - workspace_id -> graph_id
    - created_at -> create_date
    """
    
    def __init__(self, pool: asyncpg.Pool, graph_id: int, user_id: Optional[int] = None):
        """Initialize with connection pool and graph context.
        
        Args:
            pool: asyncpg connection pool
            graph_id: The graph this repository operates on
            user_id: Optional current user ID for audit trails
        """
        self._pool = pool
        self._graph_id = graph_id
        self._user_id = user_id
    
    def _row_to_inline_class(self, row: asyncpg.Record) -> InlineClass:
        """Convert database row to InlineClass entity."""
        create_date = row['create_date']
        if isinstance(create_date, str):
            create_date = datetime.fromisoformat(create_date)
        return InlineClass(
            id=row['id'],
            node_id=row['node_id'],
            class_id=row['type_id'],  # DB column still named type_id
            position=row.get('position', 0),
            create_date=create_date,
            create_uid=row.get('create_uid'),
        )
    
    # Backwards compatibility alias
    _row_to_inline_type = _row_to_inline_class
    
    async def create(self, inline_class: InlineClass) -> InlineClass:
        """Create a new inline class reference."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                INSERT INTO type_inline (node_id, type_id, position, create_date, create_uid)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id
            """, inline_class.node_id, inline_class.class_id,
                inline_class.position, inline_class.create_date,
                inline_class.create_uid or self._user_id)
            
            if row is None:
                raise RuntimeError("Failed to create inline class - no row returned")
            inline_class.id = row['id']
            return inline_class
    
    async def delete_source_inline_classes(self, source_node_id: int) -> int:
        """Delete all inline classes from a source node (for re-parsing)."""
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM type_inline WHERE node_id = $1",
                source_node_id
            )
            return int(result.split()[-1]) if result else 0
    
    # Backwards compatibility alias
    async def delete_source_inline_types(self, source_node_id: int) -> int:
        return await self.delete_source_inline_classes(source_node_id)
    
    async def get_source_inline_classes(self, source_node_id: int) -> List[InlineClass]:
        """Get all inline classes from a source node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM type_inline WHERE node_id = $1 ORDER BY position",
                source_node_id
            )
            return [self._row_to_inline_class(row) for row in rows]
    
    # Backwards compatibility alias
    async def get_source_inline_types(self, source_node_id: int) -> List[InlineClass]:
        return await self.get_source_inline_classes(source_node_id)
    
    async def get_class_references(self, class_node_id: int) -> List[InlineClass]:
        """Get all inline references to a class node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM type_inline WHERE type_id = $1",
                class_node_id
            )
            return [self._row_to_inline_class(row) for row in rows]
    
    # Backwards compatibility alias
    async def get_type_references(self, type_node_id: int) -> List[InlineClass]:
        return await self.get_class_references(type_node_id)
    
    async def bulk_create(self, inline_classes: List[InlineClass]) -> List[InlineClass]:
        """Create multiple inline classes at once using COPY."""
        if not inline_classes:
            return []
        
        async with self._pool.acquire() as conn:
            records = [
                (ic.node_id, ic.class_id, ic.position, ic.create_date,
                 ic.create_uid or self._user_id)
                for ic in inline_classes
            ]
            await conn.copy_records_to_table(
                'type_inline',
                records=records,
                columns=['node_id', 'type_id', 'position', 'create_date', 'create_uid']
            )
        
        return inline_classes
    
    async def get_inline_classes_for_graph(self, class_node_id: int) -> List[InlineClass]:
        """Get inline class references from nodes within the current graph only."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT ti.*
                FROM type_inline ti
                JOIN node n ON ti.node_id = n.id
                WHERE ti.type_id = $1 AND n.graph_id = $2
            """, class_node_id, self._graph_id)
            return [self._row_to_inline_class(row) for row in rows]
    
    # Backwards compatibility alias
    async def get_inline_types_for_graph(self, type_node_id: int) -> List[InlineClass]:
        return await self.get_inline_classes_for_graph(type_node_id)


# Backwards compatibility alias
PostgresInlineTypeRepository = PostgresInlineClassRepository
