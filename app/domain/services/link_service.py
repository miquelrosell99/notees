"""Link parsing service.

Implements linked references and path references following Logseq-style semantics.

Key concepts:
1. Link Occurrence (syntax-level): 
   - Links are parsed from text using [[nodeId]] or [[nodeId:linkUuid]] format
   - source_block_id = the block T directly containing the link
   - target_node_id = the node X being linked to
   - link_uuid = unique identifier for this specific link instance (optional, for tracking)

2. Property-based links:
   - Text properties: Links appear in root block R or descendants T
   - Node-class properties: Direct references where property owner B is the linker

3. System property `classes` is EXCLUDED from backlinks and path references
   - A separate Classes Path mechanism tracks inherited classes

4. Breadcrumbs include property provenance: T → property_name → B → … → page
"""
from __future__ import annotations

import re
import json
import uuid as uuid_module
from datetime import datetime, timezone
from typing import List, Tuple, Optional, Any, TYPE_CHECKING

from ..entities import NodeLink, InlineClass, BacklinkInfo

if TYPE_CHECKING:
    from ..repositories import NodeRepository, LinkRepository, PropertyRepository
    from ..entities import Node


# Regex pattern for parsing links - [[nodeId]] or [[nodeId:linkUuid]] format
# Group 1: target node ID (required)
# Group 2: link UUID (optional, preceded by :)
LINK_PATTERN = re.compile(r'\[\[(\d+)(?::([a-f0-9-]+))?\]\]')

# Regex pattern for parsing inline classes - {{classId}} format
INLINE_CLASS_PATTERN = re.compile(r'\{\{(\d+)\}\}')

# System property names to exclude from backlinks
EXCLUDED_PROPERTY_NAMES = ["classes", "extends"]


def generate_link_uuid() -> str:
    """Generate a new UUID v4 for a link instance."""
    return str(uuid_module.uuid4())


def sanitize_content(raw_content: str) -> str:
    """Strip editor artifacts and normalize to canonical format.
    
    Removes:
    - vscodecontentref artifacts: [[[nodeId]]](http://vscodecontentref/N)
    - Malformed internal URLs: [text](internal://nodeId) 
    - Other editor-generated link corruptions
    
    Returns canonical [[nodeId]] or [[nodeId:linkUuid]] format.
    """
    if not raw_content:
        return raw_content
    
    content = raw_content
    
    # Remove vscodecontentref artifacts: [[[nodeId]]](http://vscodecontentref/N) -> [[nodeId]]
    content = re.sub(
        r'\[\[\[([^\]]+)\]\]\]\(http://vscodecontentref/\d+\)',
        r'[[\1]]',
        content
    )
    
    # Normalize internal URLs: [text](internal://nodeId) -> [[nodeId]]
    content = re.sub(
        r'\[([^\]]*)\]\(internal://(\d+)\)',
        r'[[\2]]', 
        content
    )
    
    # Handle broken markdown links with node IDs: [[[nodeId]]] -> [[nodeId]]
    content = re.sub(
        r'\[\[\[([^\]]+)\]\]\]',
        r'[[\1]]',
        content
    )
    
    # Normalize any remaining malformed bracket patterns
    content = re.sub(
        r'\[\[\[([^\]]+)\]\]',
        r'[[\1]]',
        content
    )
    
    return content


class LinkParsingService:
    """Service for parsing and managing links in node content.
    
    Handles:
    - Text links: [[id]] syntax in node name field
    - Inline classes: {{id}} syntax in node name field
    - Property links: Node-class property values (excluding system `classes` property)
    - Classes Path: Inherited classes from ancestors for queries
    """
    
    def __init__(
        self, 
        node_repository: NodeRepository,
        link_repository: LinkRepository,
        property_repository: Optional[PropertyRepository] = None,
        classes_property_id: Optional[int] = None,
        inline_class_repository: Optional[Any] = None,
    ):
        self._node_repo = node_repository
        self._link_repo = link_repository
        self._property_repo = property_repository
        self._classes_property_id = classes_property_id
        self._inline_class_repo = inline_class_repository
    
    def parse_links(self, content: str) -> List[Tuple[int, int, Optional[str]]]:
        """Parse content and extract all links.
        
        Returns list of tuples: (target_node_id, position, link_uuid)
        Links can be [[nodeId]] or [[nodeId:linkUuid]] format.
        link_uuid is None if not present in the link syntax.
        
        Content is automatically sanitized to remove editor artifacts.
        """
        # Sanitize content first to remove editor artifacts
        sanitized_content = sanitize_content(content)
        
        links = []
        
        for match in LINK_PATTERN.finditer(sanitized_content):
            try:
                target_id = int(match.group(1))
                position = match.start()
                link_uuid = match.group(2)  # May be None if no UUID in link
                links.append((target_id, position, link_uuid))
            except ValueError:
                continue
        
        return links
    
    def parse_inline_classes(self, content: str) -> List[Tuple[int, int]]:
        """Parse content and extract all inline class references.
        
        Returns list of tuples: (class_node_id, position)
        Inline classes use {{classId}} format.
        
        Content is automatically sanitized to remove editor artifacts.
        """
        # Sanitize content first to remove editor artifacts
        sanitized_content = sanitize_content(content)
        
        inline_classes = []
        
        for match in INLINE_CLASS_PATTERN.finditer(sanitized_content):
            try:
                class_id = int(match.group(1))
                position = match.start()
                inline_classes.append((class_id, position))
            except ValueError:
                continue
        
        return inline_classes

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
        
        # Parse new links from [[id]] or [[id:uuid]] patterns
        parsed = self.parse_links(content)
        
        created_links = []
        
        for target_id, position, link_uuid in parsed:
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
                position=position,
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
    
    async def update_inline_classes(self, node_id: int, content: str) -> List[InlineClass]:
        """Parse content and update inline_class table for a node.
        
        This handles inline class references ({{classId}} in content).
        
        Args:
            node_id: The block containing the inline class references
            content: The text content to parse
            
        Returns:
            List of created InlineClass objects
        """
        if not self._inline_class_repo:
            return []
        
        # Remove existing inline classes from this source
        await self._inline_class_repo.delete_source_inline_classes(node_id)
        
        # Parse new inline classes
        parsed = self.parse_inline_classes(content)
        
        created_inline_classes = []
        
        for class_id, position in parsed:
            # Verify the class node exists
            class_node = await self._node_repo.get_by_id(class_id)
            if not class_node:
                continue
            
            inline_class = InlineClass(
                node_id=node_id,
                class_id=class_id,
                position=position,
            )
            created_class = await self._inline_class_repo.create(inline_class)
            created_inline_classes.append(created_class)
        
        return created_inline_classes
    
    async def get_inline_classes_for_node(self, node_id: int) -> List[InlineClass]:
        """Get all inline class references for a node.
        
        Args:
            node_id: The source node ID
            
        Returns:
            List of InlineClass objects for this node
        """
        if not self._inline_class_repo:
            return []
        return await self._inline_class_repo.get_source_inline_classes(node_id)
    
    async def update_property_links(
        self, 
        node_id: int, 
        property_id: int,
        target_node_ids: List[int]
    ) -> List[NodeLink]:
        """Update links for a node-class property.
        
        For node-class properties, the property owner B is the explicit linker.
        System property `classes` is excluded from backlinks entirely.
        
        Args:
            node_id: The property owner B
            property_id: The property ID
            target_node_ids: List of target node IDs referenced by the property
            
        Returns:
            List of created NodeLink objects
        """
        # Check if this is the system `classes` property - if so, skip entirely
        if property_id == self._classes_property_id:
            # Classes property is excluded from backlinks
            # Delete any existing links for this property (cleanup)
            await self._delete_property_links(node_id, property_id)
            return []
        
        # Also check by property name if ID not set
        if self._property_repo and self._classes_property_id is None:
            prop = await self._property_repo.get_by_id(property_id)
            if prop and prop.name == CLASSES_PROPERTY_NAME:
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
        
        System property `classes` links are never included.
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
              AND (p.name IS NULL OR p.name NOT IN ('classes', 'extends'))
        """, target_node_id)
        
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
        
        Uses the node_path closure table via get_breadcrumbs() for efficient
        ancestor lookup without recursive queries.
        
        Format: [(node_id, name, is_property_segment), ...]
        - For text links: T → ... → page
        - For property links: T → property_name → B → ... → page
        
        Property names are included as breadcrumb segments (is_property_segment=True).
        """
        breadcrumbs = []
        
        # Use the node repository's get_breadcrumbs method (uses closure table)
        try:
            ancestor_nodes = await self._node_repo.get_breadcrumbs(source_node_id)
        except Exception:
            # Fallback: return empty if method not available or fails
            return breadcrumbs
        
        if not ancestor_nodes:
            return breadcrumbs
        
        # ancestor_nodes is ordered from root to exit_node
        # We want: source → ... → page (source first)
        # So reverse: exit_node (source) first, then up to the containing page
        reversed_nodes = list(reversed(ancestor_nodes))
        
        first_node = True
        for node in reversed_nodes:
            # Add property segment after the first node (the source block)
            # Breadcrumb: source → property_name → ... → page
            if first_node and property_name:
                breadcrumbs.append((node.id, node.name or '', False))
                breadcrumbs.append((None, property_name, True))  # Property segment
                first_node = False
            else:
                breadcrumbs.append((node.id, node.name or '', False))
            
            # Stop at page
            if node.is_page:
                break
        
        return breadcrumbs
    
    async def get_path_references(self, node_id: int) -> List[int]:
        """Get all nodes referenced in the path from this node to root.
        
        Uses the node_path closure table for efficient ancestor lookup.
        
        This includes:
        - All text links from ancestors
        - All property links from ancestors (excluding classes)
        
        Used for query semantics where descendants inherit references.
        """
        if not hasattr(self._link_repo, 'get_connection'):
            return []
        
        pool = self._link_repo.get_connection()
        referenced_ids = set()
        
        # Get all ancestor IDs using closure table
        try:
            ancestor_ids = await self._node_repo.get_ancestors(node_id, include_self=True)
        except Exception:
            return []
        
        if not ancestor_ids:
            return []
        
        # Get all links from all ancestors in one query (excluding classes property)
        rows = await pool.fetch("""
            SELECT DISTINCT nl.target_id
            FROM node_link nl
            LEFT JOIN property p ON nl.property_id = p.id
            WHERE nl.source_id = ANY($1)
              AND (p.name IS NULL OR p.name != $2)
        """, ancestor_ids, CLASSES_PROPERTY_NAME)
        
        return [row['target_id'] for row in rows]
    
    async def update_classes_path(self, node_id: int) -> List[int]:
        """Compute and store the Classes Path for a node.
        
        Uses the node_path closure table for efficient ancestor lookup.
        
        Classes Path = ordered list of class node IDs inherited from ancestors'
        `classes` properties.
        
        This is separate from backlinks and is used for filtering/queries.
        """
        if not hasattr(self._link_repo, 'get_connection'):
            return []
        
        pool = self._link_repo.get_connection()
        classes_path = []
        
        # Get own classes first
        if self._classes_property_id:
            rows = await pool.fetch("""
                SELECT pvr.target_id
                FROM property_value_relation pvr
                WHERE pvr.node_id = $1 AND pvr.property_id = $2
                ORDER BY pvr."order"
            """, node_id, self._classes_property_id)
            classes_path.extend(row['target_id'] for row in rows)
        
        # Get ancestor IDs using closure table (ordered from root to parent)
        try:
            ancestor_ids = await self._node_repo.get_ancestors(node_id, include_self=False)
        except Exception:
            ancestor_ids = []
        
        # Collect classes from all ancestors in one query
        if ancestor_ids and self._classes_property_id:
            rows = await pool.fetch("""
                SELECT DISTINCT pvr.target_id
                FROM property_value_relation pvr
                WHERE pvr.node_id = ANY($1) AND pvr.property_id = $2
            """, ancestor_ids, self._classes_property_id)
            
            for row in rows:
                if row['target_id'] not in classes_path:
                    classes_path.append(row['target_id'])
        
        # Store classes_path
        await pool.execute(
            "UPDATE node SET classes_path = $1 WHERE id = $2",
            json.dumps(classes_path), node_id
        )
        
        return classes_path
    
    async def update_classes_path_for_descendants(self, node_id: int) -> None:
        """Update classes_path for a node and all its descendants.
        
        Uses the node_path closure table to efficiently get all descendants.
        Called when a node's classes change or when a node is reparented.
        """
        # Get all descendant IDs using closure table (includes self)
        try:
            descendant_ids = await self._node_repo.get_descendants(node_id, include_self=True)
        except Exception:
            # Fallback to just updating the current node
            await self.update_classes_path(node_id)
            return
        
        # Update classes_path for each descendant
        for desc_id in descendant_ids:
            await self.update_classes_path(desc_id)
    
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
