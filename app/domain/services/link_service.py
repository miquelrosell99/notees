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
from datetime import datetime, timezone
from typing import List, Tuple, Optional, Any, TYPE_CHECKING

from ..entities import NodeLink, InlineType, BacklinkInfo

if TYPE_CHECKING:
    from ..repositories import NodeRepository, LinkRepository, PropertyRepository
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
        inline_type_repository: Optional[Any] = None,
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
        if hasattr(self._link_repo, 'get_connection'):
            pool = self._link_repo.get_connection()
            rows = await pool.fetch(
                "SELECT target_id FROM node_link WHERE source_id = $1 AND property_id IS NULL",
                source_node_id
            )
            for row in rows:
                existing.add(row['target_id'])
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
        2. On target page: "Linked in [source page name]"
        
        Only logs for page links (target is a page).
        """
        if not target_node.is_page:
            return
        
        conn = self._link_repo.get_connection()
        now = await self._get_utc_now()
        
        # Get source page info
        source_page = None
        if source_page_id:
            source_page = await self._node_repo.get_by_id(source_page_id)
        
        # 1. Log on source page: "Link to [target] inserted"
        if source_page_id:
            await conn.execute(
                """INSERT INTO node_activity (node_id, action, details, target_node_id, create_date)
                   VALUES ($1, 'link_inserted', $2, $3, $4)""",
                source_page_id, f"Link to {target_node.name or 'Untitled'} inserted", target_node_id, now
            )
        
        # 2. Log on target page: "Linked in [source page]"
        if source_page:
            await conn.execute(
                """INSERT INTO node_activity (node_id, action, details, target_node_id, create_date)
                   VALUES ($1, 'link_inserted', $2, $3, $4)""",
                target_node_id, f"Linked in {source_page.name or 'Untitled'}", source_page_id, now
            )
    
    async def _get_utc_now(self) -> datetime:
        """Get current UTC time as datetime object."""
        from datetime import datetime, timezone
        return datetime.now(timezone.utc)
    
    async def update_node_links(self, node_id: int, content: str) -> List[NodeLink]:
        """Parse content and update link table for a node.
        
        This handles text links (direct [[id]] in content).
        Property links are handled separately by update_property_links.
        
        Also logs activity for new page link insertions:
        - On source page: "Link to [target] inserted"
        - On target page: "Linked in [source page]"
        
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
        
        # Get existing tag links to preserve them (they're managed via add_tag_link API)
        existing_tag_targets = await self._get_existing_tag_link_targets(node_id)
        
        # Remove existing non-tag text links from this source (property_id IS NULL, is_tag=0)
        await self._delete_non_tag_text_links(node_id)
        
        # Parse new links from [[id]] patterns
        parsed = self.parse_links(content)
        
        created_links = []
        
        for target_id, position in parsed:
            # Verify the target node exists
            target_node = await self._node_repo.get_by_id(target_id)
            if not target_node:
                continue
            
            # Check if this was previously a tag link - if so, preserve that
            is_tag = target_id in existing_tag_targets
            
            link = NodeLink(
                source_id=node_id,
                target_id=target_id,
                is_tag=is_tag,
            )
            created_link = await self._link_repo.create(link)
            created_links.append(created_link)
            
            # Log activity for NEW page links only (not for tag links)
            if target_id not in existing_target_ids and target_node.is_page and not is_tag:
                await self._log_link_activity(node_id, target_id, source_page_id, target_node)
        
        return created_links
    
    async def _get_existing_tag_link_targets(self, source_node_id: int) -> set[int]:
        """Get set of target node IDs for existing tag links from a source node."""
        existing = set()
        if hasattr(self._link_repo, 'get_connection'):
            pool = self._link_repo.get_connection()
            rows = await pool.fetch(
                "SELECT target_id FROM node_link WHERE source_id = $1 AND property_id IS NULL AND is_tag = TRUE",
                source_node_id
            )
            for row in rows:
                existing.add(row['target_id'])
        return existing
    
    async def _delete_non_tag_text_links(self, source_node_id: int) -> None:
        """Delete all non-tag text links (property_id IS NULL, is_tag=0) from a source node."""
        if hasattr(self._link_repo, 'get_connection'):
            pool = self._link_repo.get_connection()
            await pool.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND property_id IS NULL AND is_tag = FALSE",
                source_node_id
            )
    
    async def add_tag_link(self, source_node_id: int, target_node_id: int) -> Optional[NodeLink]:
        """Add a tag link from source to target.
        
        Creates or updates a link to mark it as a tag.
        Tags are displayed with # instead of page/block icon.
        
        Args:
            source_node_id: The block containing the [[id]] reference
            target_node_id: The page being referenced as a tag
            
        Returns:
            The created/updated NodeLink or None if target doesn't exist
        """
        # Verify target exists and is a page
        target_node = await self._node_repo.get_by_id(target_node_id)
        if not target_node or not target_node.is_page:
            return None
        
        pool = self._link_repo.get_connection()
        
        # Check if link already exists
        row = await pool.fetchrow(
            "SELECT id FROM node_link WHERE source_id = $1 AND target_id = $2 AND property_id IS NULL",
            source_node_id, target_node_id
        )
        
        if row:
            # Update existing link to be a tag
            await pool.execute(
                "UPDATE node_link SET is_tag = TRUE WHERE id = $1",
                row['id']
            )
            return NodeLink(
                id=row['id'],
                source_id=source_node_id,
                target_id=target_node_id,
                is_tag=True,
            )
        else:
            # Create new tag link
            link = NodeLink(
                source_id=source_node_id,
                target_id=target_node_id,
                is_tag=True,
            )
            return await self._link_repo.create(link)
    
    async def remove_tag_link(self, source_node_id: int, target_node_id: int) -> bool:
        """Remove a tag link (convert back to regular link or delete).
        
        Args:
            source_node_id: The block containing the reference
            target_node_id: The page being referenced
            
        Returns:
            True if a tag was removed
        """
        pool = self._link_repo.get_connection()
        
        result = await pool.execute(
            "UPDATE node_link SET is_tag = FALSE WHERE source_id = $1 AND target_id = $2 AND property_id IS NULL AND is_tag = TRUE",
            source_node_id, target_node_id
        )
        # asyncpg execute returns a status string like 'UPDATE 1'
        return result and 'UPDATE 0' not in result
    
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
                node_id=node_id,
                type_id=type_id,
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
                source_id=node_id,
                target_id=target_id,
            )
            created_link = await self._link_repo.create(link)
            created_links.append(created_link)
        
        return created_links
    
    async def _delete_property_links(self, source_node_id: int, property_id: int) -> None:
        """Delete all links for a specific property from a source node."""
        if hasattr(self._link_repo, 'get_connection'):
            pool = self._link_repo.get_connection()
            await pool.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND property_id = $2",
                source_node_id, property_id
            )
    
    async def get_backlinks(self, target_node_id: int) -> List[BacklinkInfo]:
        """Get all backlinks pointing to a node with full provenance.
        
        Returns BacklinkInfo objects containing:
        - The explicit linker (T for text links, B for property links)
        - Property provenance if applicable
        - Breadcrumb path to page ancestor
        
        System property `types` links are never included.
        """
        if not hasattr(self._link_repo, 'get_connection'):
            return []
        
        pool = self._link_repo.get_connection()
        
        # Get all links pointing to this node, with property info
        rows = await pool.fetch("""
            SELECT 
                nl.id, nl.source_id, nl.target_id, nl.position, nl.property_id,
                nl.create_date,
                n.name as source_name, n.uuid as source_uuid, n.is_page as source_is_page,
                n.page_id as source_page_id,
                p.name as property_name,
                page.name as page_name, page.uuid as page_uuid
            FROM node_link nl
            JOIN node n ON nl.source_id = n.id
            LEFT JOIN property p ON nl.property_id = p.id
            LEFT JOIN node page ON n.page_id = page.id
            WHERE nl.target_id = $1
              AND (p.name IS NULL OR p.name != $2)
        """, target_node_id, TYPES_PROPERTY_NAME)
        
        backlinks = []
        
        for row in rows:
            link = NodeLink(
                id=row['id'],
                source_id=row['source_id'],
                target_id=row['target_id'],
                position=row['position'] or 0,
            )
            
            # Build breadcrumb path
            breadcrumb_path = await self._build_breadcrumb_path(
                source_node_id=row['source_id'],
                property_name=row['property_name'],
            )
            
            backlink_info = BacklinkInfo(
                link=link,
                source_node_id=row['source_id'],
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
        
        if not hasattr(self._link_repo, 'get_connection'):
            return breadcrumbs
        
        pool = self._link_repo.get_connection()
        
        # Walk up the hierarchy from source to page
        current_id = source_node_id
        visited = set()
        first_node = True
        
        while current_id and current_id not in visited:
            visited.add(current_id)
            
            row = await pool.fetchrow(
                "SELECT id, name, parent_id, is_page FROM node WHERE id = $1",
                current_id
            )
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
        if not hasattr(self._link_repo, 'get_connection'):
            return []
        
        pool = self._link_repo.get_connection()
        referenced_ids = set()
        
        # Walk up hierarchy
        current_id = node_id
        visited = set()
        
        while current_id and current_id not in visited:
            visited.add(current_id)
            
            # Get all links from this node (excluding types property)
            rows = await pool.fetch("""
                SELECT nl.target_id
                FROM node_link nl
                LEFT JOIN property p ON nl.property_id = p.id
                WHERE nl.source_id = $1
                  AND (p.name IS NULL OR p.name != $2)
            """, current_id, TYPES_PROPERTY_NAME)
            
            for row in rows:
                referenced_ids.add(row['target_id'])
            
            # Get parent
            row = await pool.fetchrow(
                "SELECT parent_id FROM node WHERE id = $1",
                current_id
            )
            current_id = row['parent_id'] if row else None
        
        return list(referenced_ids)
    
    async def update_types_path(self, node_id: int) -> List[int]:
        """Compute and store the Types Path for a node.
        
        Types Path = ordered list of type node IDs inherited from ancestors'
        `types` properties.
        
        This is separate from backlinks and is used for filtering/queries.
        """
        if not hasattr(self._link_repo, 'get_connection'):
            return []
        
        pool = self._link_repo.get_connection()
        types_path = []
        
        # Get own types first
        if self._types_property_id:
            rows = await pool.fetch("""
                SELECT pvr.target_id
                FROM property_value_relation pvr
                WHERE pvr.node_id = $1 AND pvr.property_id = $2
                ORDER BY pvr."order"
            """, node_id, self._types_property_id)
            types_path.extend(row['target_id'] for row in rows)
        
        # Walk up hierarchy and collect ancestor types
        row = await pool.fetchrow(
            "SELECT parent_id FROM node WHERE id = $1",
            node_id
        )
        parent_id = row['parent_id'] if row else None
        
        visited = {node_id}
        while parent_id and parent_id not in visited:
            visited.add(parent_id)
            
            if self._types_property_id:
                rows = await pool.fetch("""
                    SELECT pvr.target_id
                    FROM property_value_relation pvr
                    WHERE pvr.node_id = $1 AND pvr.property_id = $2
                    ORDER BY pvr."order"
                """, parent_id, self._types_property_id)
                for row in rows:
                    if row['target_id'] not in types_path:
                        types_path.append(row['target_id'])
            
            row = await pool.fetchrow(
                "SELECT parent_id FROM node WHERE id = $1",
                parent_id
            )
            parent_id = row['parent_id'] if row else None
        
        # Store types_path
        await pool.execute(
            "UPDATE node SET types_path = $1 WHERE id = $2",
            json.dumps(types_path), node_id
        )
        
        return types_path
    
    async def update_types_path_for_descendants(self, node_id: int) -> None:
        """Update types_path for a node and all its descendants.
        
        Called when a node's types change or when a node is reparented.
        """
        await self.update_types_path(node_id)
        
        if not hasattr(self._link_repo, 'get_connection'):
            return
        
        pool = self._link_repo.get_connection()
        
        # Get all descendants
        children = await pool.fetch(
            "SELECT id FROM node WHERE parent_id = $1",
            node_id
        )
        
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
