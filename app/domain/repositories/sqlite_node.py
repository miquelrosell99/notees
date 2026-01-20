"""SQLite implementation of Node repository."""
from __future__ import annotations

import re
import json
from typing import Optional, List, TYPE_CHECKING

import aiosqlite

from ..entities import Node, NodeCreateData, NodeUpdateData, generate_uuid, utc_now_iso
from .interfaces import NodeRepository

if TYPE_CHECKING:
    pass


# Regex patterns for parsing links in node content
PAGE_LINK_PATTERN = re.compile(r'\[\[([^\]]+)\]\]')
BLOCK_LINK_PATTERN = re.compile(r'\(\(([a-f0-9-]+)\)\)')


class SQLiteNodeRepository(NodeRepository):
    """SQLite implementation of the NodeRepository."""
    
    def __init__(self, connection: aiosqlite.Connection, page_type_id: int, types_property_id: int):
        """Initialize with database connection and cached IDs.
        
        Args:
            connection: aiosqlite database connection
            page_type_id: ID of the 'page' type node (for page detection)
            types_property_id: ID of the 'types' property (for type operations)
        """
        self._conn = connection
        self._page_type_id = page_type_id
        self._types_property_id = types_property_id
    
    def get_connection(self) -> aiosqlite.Connection:
        """Get the underlying database connection."""
        return self._conn
    
    def row_to_node(self, row: aiosqlite.Row) -> Node:
        """Convert database row to Node entity (public interface)."""
        return self._row_to_node(row)
    
    def _row_to_node(self, row: aiosqlite.Row) -> Node:
        """Convert database row to Node entity."""
        # Parse JSON field for types_path
        types_path = []
        if 'types_path' in row.keys() and row['types_path']:
            try:
                types_path = json.loads(row['types_path'])
            except (json.JSONDecodeError, TypeError):
                types_path = []
        
        return Node(
            id=row['id'],
            uuid=row['uuid'],
            name=row['name'],
            icon=row['icon'],
            color=row['color'],
            parent_id=row['parent_id'],
            page_id=row['page_id'],
            sequence=row['sequence'],
            collapsed=bool(row['collapsed']),
            active=bool(row['active']) if 'active' in row.keys() else True,
            is_type=bool(row['is_type']) if 'is_type' in row.keys() else False,
            is_page=bool(row['is_page']) if 'is_page' in row.keys() else False,
            is_day=bool(row['is_day']) if 'is_day' in row.keys() else False,
            is_month=bool(row['is_month']) if 'is_month' in row.keys() else False,
            is_year=bool(row['is_year']) if 'is_year' in row.keys() else False,
            is_asset=bool(row['is_asset']) if 'is_asset' in row.keys() else False,
            is_template=bool(row['is_template']) if 'is_template' in row.keys() else False,
            is_comment=bool(row['is_comment']) if 'is_comment' in row.keys() else False,
            usable_in=row['usable_in'] if 'usable_in' in row.keys() else 'both',
            open_date=row['open_date'] if 'open_date' in row.keys() else None,
            create_date=row['create_date'],
            write_date=row['write_date'],
            create_uid=row['create_uid'],
            write_uid=row['write_uid'],
            types_path=types_path,
        )
    
    async def _compute_page_id(self, parent_id: int) -> Optional[int]:
        """Walk up parent chain to find containing page.
        
        For blocks, page_id is the first ancestor with is_page=1.
        """
        current_id = parent_id
        visited = set()
        
        while current_id and current_id not in visited:
            visited.add(current_id)
            
            # Check if current node is a page using is_page column
            cursor = await self._conn.execute(
                "SELECT id, is_page, parent_id FROM node WHERE id = ?",
                (current_id,)
            )
            row = await cursor.fetchone()
            if not row:
                break
            
            if row['is_page']:
                return current_id
            
            current_id = row['parent_id']
        
        return None
    
    async def _is_page(self, node_id: int) -> bool:
        """Check if a node is a page using is_page column."""
        cursor = await self._conn.execute(
            "SELECT is_page FROM node WHERE id = ?",
            (node_id,)
        )
        row = await cursor.fetchone()
        return bool(row['is_page']) if row else False
    
    async def create(self, data: NodeCreateData, user_id: Optional[int] = None) -> Node:
        """Create a new node."""
        now = utc_now_iso()
        uuid = generate_uuid()
        
        # Compute page_id for blocks
        page_id = None
        if data.parent_id:
            # First check if parent is a page
            if await self._is_page(data.parent_id):
                page_id = data.parent_id
            else:
                page_id = await self._compute_page_id(data.parent_id)
        
        cursor = await self._conn.execute("""
            INSERT INTO node (
                uuid, name, icon, color, parent_id, page_id, 
                sequence, collapsed, 
                is_type, is_page, is_day, is_month, is_year,
                is_asset, is_template, is_comment, usable_in,
                create_date, write_date, create_uid, write_uid
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            uuid, data.name, data.icon, data.color,
            data.parent_id, page_id, data.sequence, int(data.collapsed),
            int(data.is_type), int(data.is_page), int(data.is_day),
            int(data.is_month), int(data.is_year), int(data.is_asset),
            int(data.is_template), int(data.is_comment), data.usable_in,
            now, now, user_id, user_id
        ))
        
        node_id = cursor.lastrowid
        
        # Add types as property values using proper schema
        if data.types:
            # First create node_property assignment
            await self._conn.execute("""
                INSERT OR IGNORE INTO node_property (node_id, property_id, create_date, write_date)
                VALUES (?, ?, ?, ?)
            """, (node_id, self._types_property_id, now, now))
            
            # Get the node_property id
            cursor = await self._conn.execute(
                "SELECT id FROM node_property WHERE node_id = ? AND property_id = ?",
                (node_id, self._types_property_id)
            )
            np_row = await cursor.fetchone()
            if not np_row:
                raise RuntimeError(f"Failed to create node_property for node {node_id}")
            node_property_id = np_row['id']
            
            # Add type values to property_value_relation
            for seq, type_id in enumerate(data.types):
                await self._conn.execute("""
                    INSERT INTO property_value_relation 
                        (node_property_id, property_id, node_id, target_node_id, "order", create_date, write_date)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (node_property_id, self._types_property_id, node_id, type_id, seq, now, now))
        
        await self._conn.commit()
        
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
            create_date=now,
            write_date=now,
            create_uid=user_id,
            write_uid=user_id,
        )
    
    async def create_with_uuid(
        self, 
        uuid: str,
        data: NodeCreateData, 
        user_id: Optional[int] = None
    ) -> Node:
        """Create a new node with a specific UUID (for date nodes)."""
        now = utc_now_iso()
        
        # Compute page_id for blocks
        page_id = None
        if data.parent_id:
            if await self._is_page(data.parent_id):
                page_id = data.parent_id
            else:
                page_id = await self._compute_page_id(data.parent_id)
        
        cursor = await self._conn.execute("""
            INSERT INTO node (
                uuid, name, icon, color, parent_id, page_id, 
                sequence, collapsed,
                is_type, is_page, is_day, is_month, is_year,
                is_asset, is_template, is_comment, usable_in,
                create_date, write_date, create_uid, write_uid
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            uuid, data.name, data.icon, data.color,
            data.parent_id, page_id, data.sequence, int(data.collapsed),
            int(data.is_type), int(data.is_page), int(data.is_day),
            int(data.is_month), int(data.is_year), int(data.is_asset),
            int(data.is_template), int(data.is_comment), data.usable_in,
            now, now, user_id, user_id
        ))
        
        node_id = cursor.lastrowid
        
        # Add types as property values using proper schema
        if data.types:
            # First create node_property assignment
            await self._conn.execute("""
                INSERT OR IGNORE INTO node_property (node_id, property_id, create_date, write_date)
                VALUES (?, ?, ?, ?)
            """, (node_id, self._types_property_id, now, now))
            
            # Get the node_property id
            cursor = await self._conn.execute(
                "SELECT id FROM node_property WHERE node_id = ? AND property_id = ?",
                (node_id, self._types_property_id)
            )
            np_row = await cursor.fetchone()
            if not np_row:
                raise RuntimeError(f"Failed to create node_property for node {node_id}")
            node_property_id = np_row['id']
            
            # Add type values to property_value_relation
            for seq, type_id in enumerate(data.types):
                await self._conn.execute("""
                    INSERT INTO property_value_relation 
                        (node_property_id, property_id, node_id, target_node_id, "order", create_date, write_date)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (node_property_id, self._types_property_id, node_id, type_id, seq, now, now))
        
        await self._conn.commit()
        
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
            create_date=now,
            write_date=now,
            create_uid=user_id,
            write_uid=user_id,
        )
    
    async def get_by_id(self, node_id: int) -> Optional[Node]:
        """Get node by internal ID."""
        cursor = await self._conn.execute(
            "SELECT * FROM node WHERE id = ?", 
            (node_id,)
        )
        row = await cursor.fetchone()
        return self._row_to_node(row) if row else None
    
    async def get_by_uuid(self, uuid: str) -> Optional[Node]:
        """Get node by UUID."""
        cursor = await self._conn.execute(
            "SELECT * FROM node WHERE uuid = ?", 
            (uuid,)
        )
        row = await cursor.fetchone()
        return self._row_to_node(row) if row else None
    
    async def update(
        self, 
        node_id: int, 
        data: NodeUpdateData, 
        user_id: Optional[int] = None
    ) -> Optional[Node]:
        """Update a node."""
        node = await self.get_by_id(node_id)
        if not node:
            return None
        
        now = utc_now_iso()
        updates = []
        params = []
        
        if data.name is not None:
            updates.append("name = ?")
            params.append(data.name)
        
        if data.icon is not None:
            updates.append("icon = ?")
            params.append(data.icon)
        elif data.clear_icon:
            updates.append("icon = ?")
            params.append(None)
        
        if data.color is not None:
            updates.append("color = ?")
            params.append(data.color)
        elif data.clear_color:
            updates.append("color = ?")
            params.append(None)
        
        if data.parent_id is not None:
            updates.append("parent_id = ?")
            params.append(data.parent_id)
            # Recompute page_id by walking up hierarchy
            if await self._is_page(data.parent_id):
                page_id = data.parent_id
            else:
                page_id = await self._compute_page_id(data.parent_id)
            updates.append("page_id = ?")
            params.append(page_id)
        
        if data.sequence is not None:
            updates.append("sequence = ?")
            params.append(data.sequence)
        
        if data.collapsed is not None:
            updates.append("collapsed = ?")
            params.append(int(data.collapsed))
        
        # Handle is_* type flags
        if data.is_type is not None:
            updates.append("is_type = ?")
            params.append(int(data.is_type))
        if data.is_page is not None:
            updates.append("is_page = ?")
            params.append(int(data.is_page))
        if data.is_day is not None:
            updates.append("is_day = ?")
            params.append(int(data.is_day))
        if data.is_month is not None:
            updates.append("is_month = ?")
            params.append(int(data.is_month))
        if data.is_year is not None:
            updates.append("is_year = ?")
            params.append(int(data.is_year))
        if data.is_asset is not None:
            updates.append("is_asset = ?")
            params.append(int(data.is_asset))
        if data.is_template is not None:
            updates.append("is_template = ?")
            params.append(int(data.is_template))
        if data.is_comment is not None:
            updates.append("is_comment = ?")
            params.append(int(data.is_comment))
        if data.usable_in is not None:
            updates.append("usable_in = ?")
            params.append(data.usable_in)
        
        if not updates:
            return node
        
        updates.append("write_date = ?")
        params.append(now)
        updates.append("write_uid = ?")
        params.append(user_id)
        
        params.append(node_id)
        
        await self._conn.execute(
            f"UPDATE node SET {', '.join(updates)} WHERE id = ?",
            params
        )
        await self._conn.commit()
        
        return await self.get_by_id(node_id)
    
    async def delete(self, node_id: int) -> bool:
        """Delete a node and all its children."""
        # Get all descendant IDs recursively
        ids_to_delete = [node_id]
        queue = [node_id]
        
        while queue:
            current_id = queue.pop(0)
            cursor = await self._conn.execute(
                "SELECT id FROM node WHERE parent_id = ?",
                (current_id,)
            )
            children = await cursor.fetchall()
            for child in children:
                child_id = child['id']
                ids_to_delete.append(child_id)
                queue.append(child_id)
        
        # Delete all nodes (cascades to property values, links)
        placeholders = ','.join('?' * len(ids_to_delete))
        await self._conn.execute(
            f"DELETE FROM node WHERE id IN ({placeholders})",
            ids_to_delete
        )
        await self._conn.commit()
        
        return True
    
    async def get_children(self, parent_id: int) -> List[Node]:
        """Get direct children of a node."""
        cursor = await self._conn.execute(
            "SELECT * FROM node WHERE parent_id = ? ORDER BY sequence",
            (parent_id,)
        )
        rows = await cursor.fetchall()
        return [self._row_to_node(row) for row in rows]
    
    async def get_all_pages(self) -> List[Node]:
        """Get all active nodes tagged as 'page'."""
        cursor = await self._conn.execute("""
            SELECT * FROM node
            WHERE is_page = 1 AND active = 1
            ORDER BY write_date DESC
        """)
        rows = await cursor.fetchall()
        return [self._row_to_node(row) for row in rows]
    
    async def get_page_content(self, page_id: int) -> List[Node]:
        """Get all nodes belonging to a page (recursive children)."""
        # Get direct children and all descendants via page_id
        cursor = await self._conn.execute("""
            SELECT * FROM node 
            WHERE page_id = ? OR id = ?
            ORDER BY sequence
        """, (page_id, page_id))
        rows = await cursor.fetchall()
        return [self._row_to_node(row) for row in rows]
    
    async def search(self, query: str, limit: int = 50) -> List[Node]:
        """Search nodes by name."""
        cursor = await self._conn.execute(
            "SELECT * FROM node WHERE name LIKE ? LIMIT ?",
            (f'%{query}%', limit)
        )
        rows = await cursor.fetchall()
        return [self._row_to_node(row) for row in rows]
    
    async def get_typed_with(self, type_node_id: int) -> List[Node]:
        """Get all nodes with a specific type."""
        cursor = await self._conn.execute("""
            SELECT n.* FROM node n
            JOIN property_value_relation pvr ON n.id = pvr.node_id
            WHERE pvr.property_id = ? AND pvr.target_node_id = ?
        """, (self._types_property_id, type_node_id))
        rows = await cursor.fetchall()
        return [self._row_to_node(row) for row in rows]

    async def set_active(self, node_id: int, active: bool, user_id: Optional[int] = None) -> Optional[Node]:
        """Set the active status of a node (archive/unarchive)."""
        node = await self.get_by_id(node_id)
        if not node:
            return None
        
        now = utc_now_iso()
        await self._conn.execute(
            "UPDATE node SET active = ?, write_date = ?, write_uid = ? WHERE id = ?",
            (int(active), now, user_id, node_id)
        )
        await self._conn.commit()
        
        return await self.get_by_id(node_id)

    async def get_archived_pages(self) -> List[Node]:
        """Get all archived nodes tagged as 'page'."""
        cursor = await self._conn.execute("""
            SELECT * FROM node
            WHERE is_page = 1 AND active = 0
            ORDER BY write_date DESC
        """)
        rows = await cursor.fetchall()
        return [self._row_to_node(row) for row in rows]
