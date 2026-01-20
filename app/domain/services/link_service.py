"""Link parsing service.

Implements linked references and path references following Logseq-style semantics.

Key concepts:
1. Link Occurrence (syntax-level): 
   - Links are parsed from text nodes only using [[nodeId]] format
   - source_block_id = the block T directly containing the link
   - target_node_id = the node X being linked to

2. Property-based links:
   - Text properties: Links appear in root block R or descendants T
   - Node-type properties: Direct references where property owner B is the linker

3. System property `types` is EXCLUDED from backlinks and path references
   - A separate Types Path mechanism tracks inherited types

4. Breadcrumbs include property provenance: T → property_name → B → … → page
"""
from __future__ import annotations

import re
import json
from typing import List, Tuple, Optional, TYPE_CHECKING

from ..entities import NodeLink, InlineType, BacklinkInfo

if TYPE_CHECKING:
    from ..repositories import NodeRepository, LinkRepository, PropertyRepository, SQLiteInlineTypeRepository
    from ..entities import Node


# Regex pattern for parsing links - unified [[nodeId]] format
LINK_PATTERN = re.compile(r'\[\[(\d+)\]\]')

# Regex pattern for parsing inline types - {{typeId}} format
INLINE_TYPE_PATTERN = re.compile(r'\{\{(\d+)\}\}')

# System property name to exclude from backlinks
TYPES_PROPERTY_NAME = "types"


class LinkParsingService:
    """Service for parsing and managing links in node content.
    
    Handles:
    - Text links: [[id]] syntax in node name field
    - Inline types: {{id}} syntax in node name field
    - Property links: Node-type property values (excluding system `types` property)
    - Types Path: Inherited types from ancestors for queries
    """
    
    def __init__(
        self, 
        node_repository: NodeRepository,
        link_repository: LinkRepository,
        property_repository: Optional[PropertyRepository] = None,
        types_property_id: Optional[int] = None,
        inline_type_repository: Optional['SQLiteInlineTypeRepository'] = None,
    ):
        self._node_repo = node_repository
        self._link_repo = link_repository
        self._property_repo = property_repository
        self._types_property_id = types_property_id
        self._inline_type_repo = inline_type_repository
    
    def parse_links(self, content: str) -> List[Tuple[int, int]]:
        """Parse content and extract all links.
        
        Returns list of tuples: (target_node_id, position)
        Links are in unified [[nodeId]] format.
        """
        links = []
        
        for match in LINK_PATTERN.finditer(content):
            try:
                target_id = int(match.group(1))
                position = match.start()
                links.append((target_id, position))
            except ValueError:
                continue
        
        return links
    
    def parse_inline_types(self, content: str) -> List[Tuple[int, int]]:
        """Parse content and extract all inline type references.
        
        Returns list of tuples: (type_node_id, position)
        Inline types use {{typeId}} format.
        """
        inline_types = []
        
        for match in INLINE_TYPE_PATTERN.finditer(content):
            try:
                type_id = int(match.group(1))
                position = match.start()
                inline_types.append((type_id, position))
            except ValueError:
                continue
        
        return inline_types
    
    async def _get_existing_text_links(self, source_node_id: int) -> set[int]:
        """Get set of target node IDs for existing text links from a source node."""
        existing = set()
        if hasattr(self._link_repo, '_conn'):
            conn = self._link_repo._conn
            cursor = await conn.execute(
                "SELECT target_node_id FROM node_link WHERE source_node_id = ? AND property_id IS NULL",
                (source_node_id,)
            )
            rows = await cursor.fetchall()
            for row in rows:
                existing.add(row['target_node_id'])
        return existing
    
    async def _log_link_activity(
        self, 
        source_node_id: int, 
        target_node_id: int, 
        source_page_id: int | None,
        target_node: 'Node',
    ) -> None:
        """Log activity for a new page link insertion.
        
        Creates two activity entries:
        1. On source page: "Link to [target page name] inserted"
        2. On target page: "[source page name] linked in [this page]"
        
        Only logs for page links (target is a page).
        """
        if not target_node.is_page:
            return
        
        conn = self._link_repo._conn
        now = await self._get_utc_now()
        
        # Get source page info
        source_page = None
        if source_page_id:
            source_page = await self._node_repo.get_by_id(source_page_id)
        
        # 1. Log on source page: "Link to [target] inserted"
        if source_page_id:
            await conn.execute(
                """INSERT INTO node_activity (node_id, action, details, target_node_id, create_date)
                   VALUES (?, 'link_inserted', ?, ?, ?)""",
                (source_page_id, f"Link to {target_node.name or 'Untitled'} inserted", target_node_id, now)
            )
        
        # 2. Log on target page: "[source page] linked in [this page]"
        if source_page:
            await conn.execute(
                """INSERT INTO node_activity (node_id, action, details, target_node_id, create_date)
                   VALUES (?, 'link_inserted', ?, ?, ?)""",
                (target_node_id, f"{source_page.name or 'Untitled'} linked in {target_node.name or 'Untitled'}", source_page_id, now)
            )
        
        await conn.commit()
    
    async def _get_utc_now(self) -> str:
        """Get current UTC time as ISO string."""
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).isoformat()
    
    async def update_node_links(self, node_id: int, content: str) -> List[NodeLink]:
        """Parse content and update link table for a node.
        
        This handles text links (direct [[id]] in content).
        Property links are handled separately by update_property_links.
        
        Also logs activity for new page link insertions:
        - On source page: "Link to [target] inserted"
        - On target page: "[source page] linked in [target]"
        
        Args:
            node_id: The block T containing the link
            content: The text content to parse
            
        Returns:
            List of created NodeLink objects
        """
        # Get existing links before deleting (to track new links)
        existing_target_ids = await self._get_existing_text_links(node_id)
        
        # Get source node to determine its page
        source_node = await self._node_repo.get_by_id(node_id)
        source_page_id = source_node.page_id if source_node else None
        # If source is a page itself, use its own ID
        if source_node and source_node.is_page:
            source_page_id = source_node.id
        
        # Remove existing text links from this source (property_id IS NULL)
        await self._delete_text_links(node_id)
        
        # Parse new links
        parsed = self.parse_links(content)
        
        created_links = []
        
        for target_id, position in parsed:
            # Verify the target node exists
            target_node = await self._node_repo.get_by_id(target_id)
            if not target_node:
                continue
            
            link = NodeLink(
                source_node_id=node_id,
                target_node_id=target_id,
                position=position,
                property_id=None,  # Text link, not property link
            )
            created_link = await self._link_repo.create(link)
            created_links.append(created_link)
            
            # Log activity for NEW page links only
            if target_id not in existing_target_ids and target_node.is_page:
                await self._log_link_activity(node_id, target_id, source_page_id, target_node)
        
        return created_links
    
    async def _delete_text_links(self, source_node_id: int) -> None:
        """Delete all text links (property_id IS NULL) from a source node."""
        if hasattr(self._link_repo, '_conn'):
            conn = self._link_repo._conn
            await conn.execute(
                "DELETE FROM node_link WHERE source_node_id = ? AND property_id IS NULL",
                (source_node_id,)
            )
            await conn.commit()
    
    async def update_inline_types(self, node_id: int, content: str) -> List[InlineType]:
        """Parse content and update inline_type table for a node.
        
        This handles inline type references ({{typeId}} in content).
        
        Args:
            node_id: The block containing the inline type references
            content: The text content to parse
            
        Returns:
            List of created InlineType objects
        """
        if not self._inline_type_repo:
            return []
        
        # Remove existing inline types from this source
        await self._inline_type_repo.delete_source_inline_types(node_id)
        
        # Parse new inline types
        parsed = self.parse_inline_types(content)
        
        created_inline_types = []
        
        for type_id, position in parsed:
            # Verify the type node exists
            type_node = await self._node_repo.get_by_id(type_id)
            if not type_node:
                continue
            
            inline_type = InlineType(
                source_node_id=node_id,
                type_node_id=type_id,
                position=position,
            )
            created_type = await self._inline_type_repo.create(inline_type)
            created_inline_types.append(created_type)
        
        return created_inline_types
    
    async def get_inline_types_for_node(self, node_id: int) -> List[InlineType]:
        """Get all inline type references for a node.
        
        Args:
            node_id: The source node ID
            
        Returns:
            List of InlineType objects for this node
        """
        if not self._inline_type_repo:
            return []
        return await self._inline_type_repo.get_source_inline_types(node_id)
    
    async def update_property_links(
        self, 
        node_id: int, 
        property_id: int,
        target_node_ids: List[int]
    ) -> List[NodeLink]:
        """Update links for a node-type property.
        
        For node-type properties, the property owner B is the explicit linker.
        System property `types` is excluded from backlinks entirely.
        
        Args:
            node_id: The property owner B
            property_id: The property ID
            target_node_ids: List of target node IDs referenced by the property
            
        Returns:
            List of created NodeLink objects
        """
        # Check if this is the system `types` property - if so, skip entirely
        if property_id == self._types_property_id:
            # Types property is excluded from backlinks
            # Delete any existing links for this property (cleanup)
            await self._delete_property_links(node_id, property_id)
            return []
        
        # Also check by property name if ID not set
        if self._property_repo and self._types_property_id is None:
            prop = await self._property_repo.get_by_id(property_id)
            if prop and prop.name == TYPES_PROPERTY_NAME:
                await self._delete_property_links(node_id, property_id)
                return []
        
        # Delete existing links for this property
        await self._delete_property_links(node_id, property_id)
        
        created_links = []
        
        for target_id in target_node_ids:
            # Verify target exists
            target_node = await self._node_repo.get_by_id(target_id)
            if not target_node:
                continue
            
            link = NodeLink(
                source_node_id=node_id,
                target_node_id=target_id,
                position=0,
                property_id=property_id,
            )
            created_link = await self._link_repo.create(link)
            created_links.append(created_link)
        
        return created_links
    
    async def _delete_property_links(self, source_node_id: int, property_id: int) -> None:
        """Delete all links for a specific property from a source node."""
        if hasattr(self._link_repo, '_conn'):
            conn = self._link_repo._conn
            await conn.execute(
                "DELETE FROM node_link WHERE source_node_id = ? AND property_id = ?",
                (source_node_id, property_id)
            )
            await conn.commit()
    
    async def get_backlinks(self, target_node_id: int) -> List[BacklinkInfo]:
        """Get all backlinks pointing to a node with full provenance.
        
        Returns BacklinkInfo objects containing:
        - The explicit linker (T for text links, B for property links)
        - Property provenance if applicable
        - Breadcrumb path to page ancestor
        
        System property `types` links are never included.
        """
        if not hasattr(self._link_repo, '_conn'):
            return []
        
        conn = self._link_repo._conn
        
        # Get all links pointing to this node, with property info
        cursor = await conn.execute("""
            SELECT 
                nl.id, nl.source_node_id, nl.target_node_id, nl.position, nl.property_id,
                nl.created_at,
                n.name as source_name, n.uuid as source_uuid, n.is_page as source_is_page,
                n.page_id as source_page_id,
                p.name as property_name,
                page.name as page_name, page.uuid as page_uuid
            FROM node_link nl
            JOIN node n ON nl.source_node_id = n.id
            LEFT JOIN property p ON nl.property_id = p.id
            LEFT JOIN node page ON n.page_id = page.id
            WHERE nl.target_node_id = ?
              AND (p.name IS NULL OR p.name != ?)
        """, (target_node_id, TYPES_PROPERTY_NAME))
        
        rows = await cursor.fetchall()
        backlinks = []
        
        for row in rows:
            link = NodeLink(
                id=row['id'],
                source_node_id=row['source_node_id'],
                target_node_id=row['target_node_id'],
                position=row['position'],
                property_id=row['property_id'],
            )
            
            # Build breadcrumb path
            breadcrumb_path = await self._build_breadcrumb_path(
                source_node_id=row['source_node_id'],
                property_name=row['property_name'],
            )
            
            backlink_info = BacklinkInfo(
                link=link,
                source_node_id=row['source_node_id'],
                source_node_name=row['source_name'] or '',
                source_node_uuid=row['source_uuid'],
                source_is_page=bool(row['source_is_page']),
                source_page_id=row['source_page_id'],
                source_page_name=row['page_name'],
                source_page_uuid=row['page_uuid'],
                property_id=row['property_id'],
                property_name=row['property_name'],
                breadcrumb_path=breadcrumb_path,
            )
            backlinks.append(backlink_info)
        
        return backlinks
    
    async def _build_breadcrumb_path(
        self, 
        source_node_id: int,
        property_name: Optional[str] = None,
    ) -> List[Tuple[Optional[int], str, bool]]:
        """Build breadcrumb path from source to page ancestor.
        
        Format: [(node_id, name, is_property_segment), ...]
        - For text links: T → ... → page
        - For property links: T → property_name → B → ... → page
        
        Property names are included as breadcrumb segments (is_property_segment=True).
        """
        breadcrumbs = []
        
        if not hasattr(self._link_repo, '_conn'):
            return breadcrumbs
        
        conn = self._link_repo._conn
        
        # Walk up the hierarchy from source to page
        current_id = source_node_id
        visited = set()
        first_node = True
        
        while current_id and current_id not in visited:
            visited.add(current_id)
            
            cursor = await conn.execute(
                "SELECT id, name, parent_id, is_page FROM node WHERE id = ?",
                (current_id,)
            )
            row = await cursor.fetchone()
            if not row:
                break
            
            # Add property segment after the first node (the source block)
            # Breadcrumb: source → property_name → ... → page
            if first_node and property_name:
                breadcrumbs.append((row['id'], row['name'] or '', False))
                breadcrumbs.append((None, property_name, True))  # Property segment
                first_node = False
            else:
                breadcrumbs.append((row['id'], row['name'] or '', False))
            
            # Stop at page
            if row['is_page']:
                break
            
            current_id = row['parent_id']
        
        return breadcrumbs
    
    async def get_path_references(self, node_id: int) -> List[int]:
        """Get all nodes referenced in the path from this node to root.
        
        This includes:
        - All text links from ancestors
        - All property links from ancestors (excluding types)
        
        Used for query semantics where descendants inherit references.
        """
        if not hasattr(self._link_repo, '_conn'):
            return []
        
        conn = self._link_repo._conn
        referenced_ids = set()
        
        # Walk up hierarchy
        current_id = node_id
        visited = set()
        
        while current_id and current_id not in visited:
            visited.add(current_id)
            
            # Get all links from this node (excluding types property)
            cursor = await conn.execute("""
                SELECT nl.target_node_id
                FROM node_link nl
                LEFT JOIN property p ON nl.property_id = p.id
                WHERE nl.source_node_id = ?
                  AND (p.name IS NULL OR p.name != ?)
            """, (current_id, TYPES_PROPERTY_NAME))
            
            rows = await cursor.fetchall()
            for row in rows:
                referenced_ids.add(row['target_node_id'])
            
            # Get parent
            cursor = await conn.execute(
                "SELECT parent_id FROM node WHERE id = ?",
                (current_id,)
            )
            row = await cursor.fetchone()
            current_id = row['parent_id'] if row else None
        
        return list(referenced_ids)
    
    async def update_types_path(self, node_id: int) -> List[int]:
        """Compute and store the Types Path for a node.
        
        Types Path = ordered list of type node IDs inherited from ancestors'
        `types` properties.
        
        This is separate from backlinks and is used for filtering/queries.
        """
        if not hasattr(self._link_repo, '_conn'):
            return []
        
        conn = self._link_repo._conn
        types_path = []
        
        # Get own types first
        if self._types_property_id:
            cursor = await conn.execute("""
                SELECT pvr.target_node_id
                FROM property_value_relation pvr
                WHERE pvr.node_id = ? AND pvr.property_id = ?
                ORDER BY pvr."order"
            """, (node_id, self._types_property_id))
            rows = await cursor.fetchall()
            types_path.extend(row['target_node_id'] for row in rows)
        
        # Walk up hierarchy and collect ancestor types
        cursor = await conn.execute(
            "SELECT parent_id FROM node WHERE id = ?",
            (node_id,)
        )
        row = await cursor.fetchone()
        parent_id = row['parent_id'] if row else None
        
        visited = {node_id}
        while parent_id and parent_id not in visited:
            visited.add(parent_id)
            
            if self._types_property_id:
                cursor = await conn.execute("""
                    SELECT pvr.target_node_id
                    FROM property_value_relation pvr
                    WHERE pvr.node_id = ? AND pvr.property_id = ?
                    ORDER BY pvr."order"
                """, (parent_id, self._types_property_id))
                rows = await cursor.fetchall()
                for row in rows:
                    if row['target_node_id'] not in types_path:
                        types_path.append(row['target_node_id'])
            
            cursor = await conn.execute(
                "SELECT parent_id FROM node WHERE id = ?",
                (parent_id,)
            )
            row = await cursor.fetchone()
            parent_id = row['parent_id'] if row else None
        
        # Store types_path
        await conn.execute(
            "UPDATE node SET types_path = ? WHERE id = ?",
            (json.dumps(types_path), node_id)
        )
        await conn.commit()
        
        return types_path
    
    async def update_types_path_for_descendants(self, node_id: int) -> None:
        """Update types_path for a node and all its descendants.
        
        Called when a node's types change or when a node is reparented.
        """
        await self.update_types_path(node_id)
        
        if not hasattr(self._link_repo, '_conn'):
            return
        
        conn = self._link_repo._conn
        
        # Get all descendants
        cursor = await conn.execute(
            "SELECT id FROM node WHERE parent_id = ?",
            (node_id,)
        )
        children = await cursor.fetchall()
        
        for child in children:
            await self.update_types_path_for_descendants(child['id'])
    
    def strip_links(self, content: str) -> str:
        """Remove link markup from content, leaving just the node IDs as text.
        
        [[123]] -> 123
        """
        return LINK_PATTERN.sub(r'\1', content).strip()
    
    def render_links(self, content: str, link_map: dict) -> str:
        """Render content with links as HTML anchors.
        
        Args:
            content: Raw content with [[nodeId]] links
            link_map: Dict mapping node IDs to their names
        
        Returns:
            HTML string with clickable links
        """
        def link_replacer(match):
            node_id = match.group(1)
            if node_id in link_map:
                name = link_map[node_id].get('name', node_id)
                is_page = link_map[node_id].get('is_page', True)
                link_class = 'page-link' if is_page else 'block-link'
                return f'<a href="/node/{node_id}" class="node-link {link_class}">{name}</a>'
            return f'<span class="node-link unresolved">{node_id}</span>'
        
        return LINK_PATTERN.sub(link_replacer, content)
