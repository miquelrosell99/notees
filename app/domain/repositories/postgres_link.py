"""PostgreSQL implementation of Link repository.

Updated for graph-based schema:
- node_link table: source_id, target_id, is_tag, is_inline_class
- Inline class references are now stored in node_link with is_inline_class=TRUE
- All timestamps use create_date
- User tracking via create_uid
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

import asyncpg

from ..entities import NodeLink
from .interfaces import LinkRepository
from .base import normalize_timestamp
from ...utils import utc_now
from ...db.connection import acquire_connection


class PostgresLinkRepository(LinkRepository):
    """PostgreSQL implementation of the LinkRepository.
    
    Handles both regular node links and inline class references
    (distinguished by is_inline_class flag on node_link table).
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
            is_inline_class=row.get('is_inline_class', False),
            name=row.get('name'),
            create_date=create_date,
            create_uid=row.get('create_uid'),
        )
    
    async def create(self, link: NodeLink) -> NodeLink:
        """Create a new link."""
        async with acquire_connection(self._pool) as conn:
            if link.uuid:
                row = await conn.fetchrow("""
                    INSERT INTO node_link (uuid, source_id, target_id, is_tag, is_inline_class, name, create_date, create_uid, graph_id)
                    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
                    RETURNING id, uuid
                """, link.uuid, link.source_id, link.target_id, link.is_tag, link.is_inline_class,
                    link.name, link.create_date, link.create_uid or self._user_id, self._graph_id)
            else:
                row = await conn.fetchrow("""
                    INSERT INTO node_link (source_id, target_id, is_tag, is_inline_class, name, create_date, create_uid, graph_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    RETURNING id, uuid
                """, link.source_id, link.target_id, link.is_tag, link.is_inline_class,
                    link.name, link.create_date, link.create_uid or self._user_id, self._graph_id)
            
            if row is None:
                raise RuntimeError("Failed to create link - no row returned")
            link.id = row['id']
            link.uuid = str(row['uuid'])
            return link
    
    async def delete_source_links(self, source_node_id: int) -> int:
        """Delete all links from a source node (for re-parsing)."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1",
                source_node_id
            )
            # Parse "DELETE n" to get count
            return int(result.split()[-1]) if result else 0
    
    async def get_source_links(self, source_node_id: int) -> List[NodeLink]:
        """Get all links from a source node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE source_id = $1",
                source_node_id
            )
            return [self._row_to_link(row) for row in rows]
    
    async def get_backlinks(self, target_node_id: int) -> List[NodeLink]:
        """Get all links pointing to a target node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE target_id = $1",
                target_node_id
            )
            return [self._row_to_link(row) for row in rows]
    
    async def get_page_backlinks(self, page_id: int) -> List[NodeLink]:
        """Get backlinks with inheritance (links from nodes in this graph)."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT nl.*, n.page_id as source_page_id
                FROM node_link nl
                JOIN node n ON nl.source_id = n.id
                WHERE nl.target_id = $1 AND n.graph_id = $2
            """, page_id, self._graph_id)
            return [self._row_to_link(row) for row in rows]
    
    async def get_outgoing_links(self, source_node_id: int) -> List[NodeLink]:
        """Get all links from a source node."""
        async with acquire_connection(self._pool) as conn:
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
        
        async with acquire_connection(self._pool) as conn:
            # Use copy_records_to_table for best performance
            records = [
                (link.source_id, link.target_id, link.is_tag, link.is_inline_class,
                 link.create_date, link.create_uid or self._user_id)
                for link in links
            ]
            await conn.copy_records_to_table(
                'node_link',
                records=records,
                columns=['source_id', 'target_id', 'is_tag', 'is_inline_class',
                        'create_date', 'create_uid']
            )
        
        return links
    
    async def delete_text_links(self, source_node_id: int) -> int:
        """Delete all text links from a source node.
        
        Deletes non-tag, non-inline-class links from the source.
        """
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND is_tag = FALSE AND is_inline_class = FALSE",
                source_node_id
            )
            return int(result.split()[-1]) if result else 0
    
    async def delete_tag_links(self, source_node_id: int) -> int:
        """Delete all tag links from a source node."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND is_tag = TRUE",
                source_node_id
            )
            return int(result.split()[-1]) if result else 0
    
    async def get_backlinks_for_graph(self, target_node_id: int) -> List[NodeLink]:
        """Get backlinks from nodes within the current graph only."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT nl.*
                FROM node_link nl
                JOIN node n ON nl.source_id = n.id
                WHERE nl.target_id = $1 AND n.graph_id = $2
            """, target_node_id, self._graph_id)
            return [self._row_to_link(row) for row in rows]
    
    # ============== Inline Class Methods ==============
    
    async def delete_source_inline_classes(self, source_node_id: int) -> int:
        """Delete all inline class links from a source node (for re-parsing)."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND is_inline_class = TRUE",
                source_node_id
            )
            return int(result.split()[-1]) if result else 0
    
    async def get_source_inline_classes(self, source_node_id: int) -> List[NodeLink]:
        """Get all inline class links from a source node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE source_id = $1 AND is_inline_class = TRUE ORDER BY position",
                source_node_id
            )
            return [self._row_to_link(row) for row in rows]
    
    async def get_inline_class_references(self, target_node_id: int) -> List[NodeLink]:
        """Get all inline class links pointing to a target node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE target_id = $1 AND is_inline_class = TRUE",
                target_node_id
            )
            return [self._row_to_link(row) for row in rows]
    
    async def get_inline_classes_for_graph(self, target_node_id: int) -> List[NodeLink]:
        """Get inline class references from nodes within the current graph only."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT nl.*
                FROM node_link nl
                JOIN node n ON nl.source_id = n.id
                WHERE nl.target_id = $1 AND nl.is_inline_class = TRUE AND n.graph_id = $2
            """, target_node_id, self._graph_id)
            return [self._row_to_link(row) for row in rows]
