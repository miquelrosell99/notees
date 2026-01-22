"""PostgreSQL implementation of Link repository."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional, Any

import asyncpg

from ..entities import NodeLink, InlineType
from .interfaces import LinkRepository


def utc_now() -> datetime:
    """Get current UTC datetime."""
    return datetime.now(timezone.utc)


class PostgresLinkRepository(LinkRepository):
    """PostgreSQL implementation of the LinkRepository."""
    
    def __init__(self, pool: asyncpg.Pool, workspace_id: int):
        """Initialize with connection pool and workspace context."""
        self._pool = pool
        self._workspace_id = workspace_id
    
    def _row_to_link(self, row: asyncpg.Record) -> NodeLink:
        """Convert database row to NodeLink entity."""
        created_at = row['created_at']
        if isinstance(created_at, str):
            created_at = datetime.fromisoformat(created_at)
        return NodeLink(
            id=row['id'],
            source_node_id=row['source_node_id'],
            target_node_id=row['target_node_id'],
            position=row.get('position', 0),
            property_id=row.get('property_id'),
            is_tag=row.get('is_tag', False),
            created_at=created_at,
        )
    
    async def create(self, link: NodeLink) -> NodeLink:
        """Create a new link."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                INSERT INTO node_link (source_node_id, target_node_id, position, property_id, is_tag, created_at)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id
            """, link.source_node_id, link.target_node_id, link.position, 
                link.property_id, link.is_tag, link.created_at)
            
            link.id = row['id']
            return link
    
    async def delete_source_links(self, source_node_id: int) -> int:
        """Delete all links from a source node (for re-parsing)."""
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_node_id = $1",
                source_node_id
            )
            # Parse "DELETE n" to get count
            return int(result.split()[-1]) if result else 0
    
    async def get_source_links(self, source_node_id: int) -> List[NodeLink]:
        """Get all links from a source node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE source_node_id = $1",
                source_node_id
            )
            return [self._row_to_link(row) for row in rows]
    
    async def get_backlinks(self, target_node_id: int) -> List[NodeLink]:
        """Get all links pointing to a target node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE target_node_id = $1",
                target_node_id
            )
            return [self._row_to_link(row) for row in rows]
    
    async def get_page_backlinks(self, page_id: int) -> List[NodeLink]:
        """Get backlinks with inheritance."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT nl.*, n.page_id as source_page_id
                FROM node_link nl
                JOIN node n ON nl.source_node_id = n.id
                WHERE nl.target_node_id = $1 AND n.workspace_id = $2
            """, page_id, self._workspace_id)
            return [self._row_to_link(row) for row in rows]
    
    async def get_outgoing_links(self, source_node_id: int) -> List[NodeLink]:
        """Get all links from a source node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE source_node_id = $1",
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
                (link.source_node_id, link.target_node_id, link.position, 
                 link.property_id, link.is_tag, link.created_at)
                for link in links
            ]
            await conn.copy_records_to_table(
                'node_link',
                records=records,
                columns=['source_node_id', 'target_node_id', 'position', 
                        'property_id', 'is_tag', 'created_at']
            )
        
        return links
    
    async def delete_text_links(self, source_node_id: int) -> int:
        """Delete all text links (property_id IS NULL) from a source node."""
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_node_id = $1 AND property_id IS NULL",
                source_node_id
            )
            return int(result.split()[-1]) if result else 0
    
    async def delete_property_links(self, source_node_id: int, property_id: int) -> int:
        """Delete all links for a specific property from a source node."""
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_node_id = $1 AND property_id = $2",
                source_node_id, property_id
            )
            return int(result.split()[-1]) if result else 0
    
    async def get_backlinks_excluding_types(
        self, 
        target_node_id: int, 
        types_property_name: str = "types"
    ) -> List[NodeLink]:
        """Get backlinks excluding the system types property."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT nl.*
                FROM node_link nl
                LEFT JOIN property p ON nl.property_id = p.id
                WHERE nl.target_node_id = $1
                  AND (p.name IS NULL OR p.name != $2)
            """, target_node_id, types_property_name)
            return [self._row_to_link(row) for row in rows]


class PostgresInlineTypeRepository:
    """PostgreSQL repository for inline type references."""
    
    def __init__(self, pool: asyncpg.Pool, workspace_id: int):
        """Initialize with connection pool and workspace context."""
        self._pool = pool
        self._workspace_id = workspace_id
    
    def _row_to_inline_type(self, row: asyncpg.Record) -> InlineType:
        """Convert database row to InlineType entity."""
        created_at = row['created_at']
        if isinstance(created_at, str):
            created_at = datetime.fromisoformat(created_at)
        return InlineType(
            id=row['id'],
            source_node_id=row['source_node_id'],
            type_node_id=row['type_node_id'],
            position=row.get('position', 0),
            created_at=created_at,
        )
    
    async def create(self, inline_type: InlineType) -> InlineType:
        """Create a new inline type reference."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                INSERT INTO inline_type (source_node_id, type_node_id, position, created_at)
                VALUES ($1, $2, $3, $4)
                RETURNING id
            """, inline_type.source_node_id, inline_type.type_node_id,
                inline_type.position, inline_type.created_at)
            
            inline_type.id = row['id']
            return inline_type
    
    async def delete_source_inline_types(self, source_node_id: int) -> int:
        """Delete all inline types from a source node (for re-parsing)."""
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM inline_type WHERE source_node_id = $1",
                source_node_id
            )
            return int(result.split()[-1]) if result else 0
    
    async def get_source_inline_types(self, source_node_id: int) -> List[InlineType]:
        """Get all inline types from a source node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM inline_type WHERE source_node_id = $1 ORDER BY position",
                source_node_id
            )
            return [self._row_to_inline_type(row) for row in rows]
    
    async def get_type_references(self, type_node_id: int) -> List[InlineType]:
        """Get all inline references to a type node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM inline_type WHERE type_node_id = $1",
                type_node_id
            )
            return [self._row_to_inline_type(row) for row in rows]
    
    async def bulk_create(self, inline_types: List[InlineType]) -> List[InlineType]:
        """Create multiple inline types at once using COPY."""
        if not inline_types:
            return []
        
        async with self._pool.acquire() as conn:
            records = [
                (it.source_node_id, it.type_node_id, it.position, it.created_at)
                for it in inline_types
            ]
            await conn.copy_records_to_table(
                'inline_type',
                records=records,
                columns=['source_node_id', 'type_node_id', 'position', 'created_at']
            )
        
        return inline_types
