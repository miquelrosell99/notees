"""SQLite implementation of Link repository."""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

import aiosqlite

from ..entities import NodeLink
from .interfaces import LinkRepository


class SQLiteLinkRepository(LinkRepository):
    """SQLite implementation of the LinkRepository."""
    
    def __init__(self, connection: aiosqlite.Connection):
        """Initialize with database connection."""
        self._conn = connection
    
    def _row_to_link(self, row: aiosqlite.Row) -> NodeLink:
        """Convert database row to NodeLink entity."""
        created_at = row['created_at']
        if isinstance(created_at, str):
            created_at = datetime.fromisoformat(created_at)
        return NodeLink(
            id=row['id'],
            source_node_id=row['source_node_id'],
            target_node_id=row['target_node_id'],
            position=row['position'],
            property_id=row['property_id'] if 'property_id' in row.keys() else None,
            created_at=created_at,
        )
    
    async def create(self, link: NodeLink) -> NodeLink:
        """Create a new link."""
        cursor = await self._conn.execute("""
            INSERT INTO node_link (source_node_id, target_node_id, position, property_id, created_at)
            VALUES (?, ?, ?, ?, ?)
        """, (
            link.source_node_id, 
            link.target_node_id, 
            link.position,
            link.property_id,
            link.created_at.isoformat()
        ))
        
        link.id = cursor.lastrowid
        await self._conn.commit()
        return link
    
    async def delete_source_links(self, source_node_id: int) -> int:
        """Delete all links from a source node (for re-parsing)."""
        cursor = await self._conn.execute(
            "DELETE FROM node_link WHERE source_node_id = ?",
            (source_node_id,)
        )
        await self._conn.commit()
        return cursor.rowcount
    
    async def get_source_links(self, source_node_id: int) -> List[NodeLink]:
        """Get all links from a source node."""
        cursor = await self._conn.execute(
            "SELECT * FROM node_link WHERE source_node_id = ?",
            (source_node_id,)
        )
        rows = await cursor.fetchall()
        return [self._row_to_link(row) for row in rows]
    
    async def get_backlinks(self, target_node_id: int) -> List[NodeLink]:
        """Get all links pointing to a target node."""
        cursor = await self._conn.execute(
            "SELECT * FROM node_link WHERE target_node_id = ?",
            (target_node_id,)
        )
        rows = await cursor.fetchall()
        return [self._row_to_link(row) for row in rows]
    
    async def get_page_backlinks(self, page_id: int) -> List[NodeLink]:
        """Get backlinks with inheritance.
        
        Returns all links pointing to this page, including links
        from blocks that belong to other pages.
        """
        cursor = await self._conn.execute("""
            SELECT nl.*, n.page_id as source_page_id
            FROM node_link nl
            JOIN node n ON nl.source_node_id = n.id
            WHERE nl.target_node_id = ?
        """, (page_id,))
        rows = await cursor.fetchall()
        return [self._row_to_link(row) for row in rows]
    
    async def get_outgoing_links(self, source_node_id: int) -> List[NodeLink]:
        """Get all links from a source node."""
        cursor = await self._conn.execute(
            "SELECT * FROM node_link WHERE source_node_id = ?",
            (source_node_id,)
        )
        rows = await cursor.fetchall()
        return [self._row_to_link(row) for row in rows]
    
    async def bulk_create(self, links: List[NodeLink]) -> List[NodeLink]:
        """Create multiple links at once (for efficiency when parsing)."""
        if not links:
            return []
        
        cursor = await self._conn.executemany("""
            INSERT INTO node_link (source_node_id, target_node_id, position, property_id, created_at)
            VALUES (?, ?, ?, ?, ?)
        """, [
            (link.source_node_id, link.target_node_id, link.position, link.property_id, link.created_at.isoformat())
            for link in links
        ])
        
        await self._conn.commit()
        return links  # IDs not set but that's okay for bulk operations
    
    async def delete_text_links(self, source_node_id: int) -> int:
        """Delete all text links (property_id IS NULL) from a source node."""
        cursor = await self._conn.execute(
            "DELETE FROM node_link WHERE source_node_id = ? AND property_id IS NULL",
            (source_node_id,)
        )
        await self._conn.commit()
        return cursor.rowcount
    
    async def delete_property_links(self, source_node_id: int, property_id: int) -> int:
        """Delete all links for a specific property from a source node."""
        cursor = await self._conn.execute(
            "DELETE FROM node_link WHERE source_node_id = ? AND property_id = ?",
            (source_node_id, property_id)
        )
        await self._conn.commit()
        return cursor.rowcount
    
    async def get_backlinks_excluding_types(
        self, 
        target_node_id: int, 
        types_property_name: str = "types"
    ) -> List[NodeLink]:
        """Get backlinks to a node, excluding the system types property.
        
        This is used for the linked references panel where types should not appear.
        """
        cursor = await self._conn.execute("""
            SELECT nl.*
            FROM node_link nl
            LEFT JOIN property p ON nl.property_id = p.id
            WHERE nl.target_node_id = ?
              AND (p.name IS NULL OR p.name != ?)
        """, (target_node_id, types_property_name))
        rows = await cursor.fetchall()
        return [self._row_to_link(row) for row in rows]
