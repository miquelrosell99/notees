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

3. Classes are stored in class_ids column and tracked separately via Classes Path

4. Breadcrumbs include property provenance: T → property_name → B → … → page
"""
from __future__ import annotations

import re
import json
import uuid as uuid_module
from datetime import datetime, timezone
from typing import List, Tuple, Optional, Any, TYPE_CHECKING

from ..entities import NodeLink, BacklinkInfo
from ..stringify_ast import stringify_ast, parse_ast, StringifyOptions, StringifyMode, ParseMode

if TYPE_CHECKING:
    from ..repositories import NodeRepository, LinkRepository, PropertyRepository
    from ..entities import Node


# Regex pattern for parsing links - [[nodeId]] or [[nodeId:linkUuid]] format
# Group 1: target node ID (required)
# Group 2: link UUID (optional, preceded by :)
LINK_PATTERN = re.compile(r'\[\[(\d+)(?::([a-f0-9-]+))?\]\]')

# Properties excluded from backlinks (extends excluded for inheritance)
EXCLUDED_PROPERTY_NAMES = ["extends"]


def generate_link_uuid() -> str:
    """Generate a new UUID v4 for a link instance."""
    return str(uuid_module.uuid4())


def _parse_links_from_ast(content: str) -> Optional[List[Tuple[str, int, Optional[str], Optional[str]]]]:
    """Try to parse content as AST JSON and extract node links (ref_type='node').
    
    Returns None if content is not valid AST JSON, otherwise returns
    list of (target_node_uuid, position, link_uuid, label) tuples.
    
    The link_id format is "nodeUuid:linkUuid" (or legacy "nodeId:linkUuid").
    Label is the custom display text from the 'label' field in the AST node.
    """
    try:
        ast = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return None
    
    if not isinstance(ast, list):
        return None
    
    # Validate it looks like an AST document (array of objects with 'type')
    if ast and (not isinstance(ast[0], dict) or 'type' not in ast[0]):
        return None
    
    links: List[Tuple[str, int, Optional[str], Optional[str]]] = []
    position = 0
    
    def walk(nodes: Any) -> None:
        nonlocal position
        if not isinstance(nodes, list):
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            if node.get('type') == 'node_link' and node.get('ref_type', 'node') == 'node':
                link_id = str(node.get('link_id', ''))
                # link_id format: "nodeUuid:linkUuid" (or legacy "nodeId:linkUuid")
                parts = link_id.split(':', 1)
                if not parts[0]:
                    continue
                node_identifier = parts[0]  # UUID string (or legacy numeric ID)
                link_uuid = parts[1] if len(parts) > 1 else None
                # Extract custom label if present
                label = node.get('label')
                links.append((node_identifier, position, link_uuid, label))
                position += 1
            # Recurse into children
            if 'children' in node:
                walk(node['children'])
    
    walk(ast)
    return links


def _parse_inline_classes_from_ast(content: str) -> Optional[List[Tuple[str, int, Optional[str]]]]:
    """Try to parse content as AST JSON and extract inline class refs (ref_type='class').
    
    Returns None if content is not valid AST JSON, otherwise returns
    list of (node_identifier, position, link_uuid) tuples.
    
    The link_id format is "nodeUuid:linkUuid" (or legacy numeric "classId").
    """
    try:
        ast = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return None
    
    if not isinstance(ast, list):
        return None
    
    if ast and (not isinstance(ast[0], dict) or 'type' not in ast[0]):
        return None
    
    classes: List[Tuple[str, int, Optional[str]]] = []
    position = 0
    
    def walk(nodes: Any) -> None:
        nonlocal position
        if not isinstance(nodes, list):
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            if node.get('type') == 'node_link' and node.get('ref_type') == 'class':
                link_id = str(node.get('link_id', ''))
                # link_id format: "nodeUuid:linkUuid" (or legacy "classId")
                parts = link_id.split(':', 1)
                if not parts[0]:
                    continue
                node_identifier = parts[0]  # UUID string (or legacy numeric ID)
                link_uuid = parts[1] if len(parts) > 1 else None
                classes.append((node_identifier, position, link_uuid))
                position += 1
            if 'children' in node:
                walk(node['children'])
    
    walk(ast)
    return classes


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
    - Inline classes: ref_type='class' in AST content (stored with is_inline_class=True)
    - Property links: Node-class property values
    - Classes Path: Inherited classes from ancestors for queries (classes stored in class_ids column)
    """
    
    def __init__(
        self, 
        node_repository: NodeRepository,
        link_repository: LinkRepository,
        property_repository: Optional[PropertyRepository] = None,
    ):
        self._node_repo = node_repository
        self._link_repo = link_repository
        self._property_repo = property_repository
    
    def parse_links(self, content: str) -> List[Tuple[str, int, Optional[str], Optional[str]]]:
        """Parse content and extract all links.
        
        Returns list of tuples: (target_node_uuid, position, link_uuid, label)
        Extracts node_link entries with ref_type='node' from AST JSON content.
        The first element is the node UUID (or legacy numeric ID string).
        Label is the custom display text if present.
        """
        return _parse_links_from_ast(content) or []
    
    def parse_inline_classes(self, content: str) -> List[Tuple[str, int, Optional[str]]]:
        """Parse content and extract all inline class references.
        
        Returns list of tuples: (node_identifier, position, link_uuid)
        Extracts node_link entries with ref_type='class' from AST JSON content.
        """
        return _parse_inline_classes_from_ast(content) or []

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
    
    @staticmethod
    def _node_name_to_text(name: str | None) -> str:
        """Convert a node's raw AST name to plain text."""
        if not name:
            return 'Untitled'
        try:
            ast = parse_ast(name, ParseMode.JSON)
            text = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
            return text.strip() or 'Untitled'
        except Exception:
            return name or 'Untitled'

    @staticmethod
    def _notees_link(name: str | None, uuid: str) -> str:
        """Build a markdown-style link with notees: URI.
        
        Returns: [Node Name](notees:uuid)
        """
        text = LinkParsingService._node_name_to_text(name)
        return f"[{text}](notees:{uuid})"

    async def _log_link_activity(
        self, 
        source_node_id: int, 
        target_node_id: int, 
        source_page_id: int | None,
        target_node: 'Node',
    ) -> None:
        """Log activity for a new page link insertion.
        
        Creates two activity entries:
        1. On source page: "Link to [target page name](notees:uuid) inserted"
        2. On target page: "Linked in [source page name](notees:uuid)"
        
        Uses notees: URI scheme with node UUID for stable, navigable links.
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
        
        # Build markdown links with notees: URI
        target_link = self._notees_link(target_node.name, target_node.uuid)
        
        # 1. Log on source page: "Link to [target](notees:uuid) inserted"
        if source_page_id:
            await conn.execute(
                """INSERT INTO node_activity (node_id, action, details, target_node_id, create_date)
                   VALUES ($1, 'link_inserted', $2, $3, $4)""",
                source_page_id, f"Link to {target_link} inserted", target_node_id, now
            )
        
        # 2. Log on target page: "Linked in [source page](notees:uuid)"
        if source_page:
            source_link = self._notees_link(source_page.name, source_page.uuid)
            await conn.execute(
                """INSERT INTO node_activity (node_id, action, details, target_node_id, create_date)
                   VALUES ($1, 'link_inserted', $2, $3, $4)""",
                target_node_id, f"Linked in {source_link}", source_page_id, now
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
        
        # Page nodes may not contain inline node links — enforce the constraint
        # and return early (existing links were already cleaned up above).
        if source_node and source_node.is_page:
            return []
        
        # Parse new links from AST (link_id format: "nodeUuid:linkUuid")
        parsed = self.parse_links(content)
        
        created_links = []
        
        for node_identifier, position, link_uuid, label in parsed:
            # Resolve the target node — try UUID first, fall back to numeric ID
            target_node = None
            try:
                # Legacy format: numeric ID
                target_id = int(node_identifier)
                target_node = await self._node_repo.get_by_id(target_id)
            except (ValueError, TypeError):
                # New format: UUID string
                target_node = await self._node_repo.get_by_uuid(node_identifier)
            
            if not target_node:
                continue
            
            target_id = target_node.id
            
            # Check if this was previously a tag link - if so, preserve that
            is_tag = target_id in existing_tag_targets
            
            link = NodeLink(
                source_id=node_id,
                target_id=target_id,
                uuid=link_uuid,
                is_tag=is_tag,
                position=position,
                name=None,  # Label lives in the AST, not in the DB
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
        """Delete all non-tag, non-inline-class text links from a source node."""
        if hasattr(self._link_repo, 'get_connection'):
            pool = self._link_repo.get_connection()
            await pool.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND property_id IS NULL AND is_tag = FALSE AND is_inline_class = FALSE",
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
    
    async def update_inline_classes(self, node_id: int, content: str) -> List[NodeLink]:
        """Parse content and update inline class links for a node.
        
        Inline class references (ref_type='class' in AST) are stored as
        NodeLink entries with is_inline_class=True AND added to class_ids array.
        
        Args:
            node_id: The block containing the inline class references
            content: The text content to parse
            
        Returns:
            List of created NodeLink objects (with is_inline_class=True)
        """
        # Get old inline class IDs BEFORE deleting them
        from ...db.connection import acquire_connection
        pool = self._node_repo.get_connection()
        
        old_inline_class_ids = set()
        async with acquire_connection(pool) as conn:
            old_inline_rows = await conn.fetch(
                "SELECT DISTINCT target_id FROM node_link WHERE source_id = $1 AND is_inline_class = TRUE",
                node_id
            )
            old_inline_class_ids = {r['target_id'] for r in old_inline_rows}
        
        # Remove existing inline class links from this source
        await self._link_repo.delete_source_inline_classes(node_id)
        
        # Parse new inline classes from AST
        parsed = self.parse_inline_classes(content)
        
        created_links = []
        new_inline_class_ids = []
        
        for node_identifier, position, link_uuid in parsed:
            # Resolve identifier: try as UUID first, fall back to numeric ID
            class_node = None
            try:
                numeric_id = int(node_identifier)
                class_node = await self._node_repo.get_by_id(numeric_id)
            except (ValueError, TypeError):
                # Not numeric — treat as UUID
                class_node = await self._node_repo.get_by_uuid(node_identifier)
            
            if not class_node:
                continue
            
            link = NodeLink(
                source_id=node_id,
                target_id=class_node.id,
                position=position,
                is_inline_class=True,
                uuid=link_uuid,
            )
            created_link = await self._link_repo.create(link)
            created_links.append(created_link)
            new_inline_class_ids.append(class_node.id)
        
        # Update class_ids array to include inline classes
        async with acquire_connection(pool) as conn:
            row = await conn.fetchrow(
                "SELECT class_ids FROM node WHERE id = $1",
                node_id
            )
            if row:
                current_class_ids = list(row['class_ids'] or [])
                
                # Remove old inline classes from class_ids
                filtered_class_ids = [cid for cid in current_class_ids if cid not in old_inline_class_ids]
                
                # Add new inline classes to class_ids (avoid duplicates)
                for class_id in new_inline_class_ids:
                    if class_id not in filtered_class_ids:
                        filtered_class_ids.append(class_id)
                
                # Update the class_ids array
                await conn.execute(
                    "UPDATE node SET class_ids = $1, write_date = NOW(), version = version + 1 WHERE id = $2",
                    filtered_class_ids, node_id
                )
        
        return created_links
    
    async def get_inline_classes_for_node(self, node_id: int) -> List[NodeLink]:
        """Get all inline class links for a node.
        
        Args:
            node_id: The source node ID
            
        Returns:
            List of NodeLink objects with is_inline_class=True
        """
        return await self._link_repo.get_source_inline_classes(node_id)
    
    async def update_property_links(
        self, 
        node_id: int, 
        property_id: int,
        target_node_ids: List[int]
    ) -> List[NodeLink]:
        """Update links for a node-class property.
        
        For node-class properties, the property owner B is the explicit linker.
        Classes are now stored in class_ids column, not as a property.
        
        Args:
            node_id: The property owner B
            property_id: The property ID
            target_node_ids: List of target node IDs referenced by the property
            
        Returns:
            List of created NodeLink objects
        """
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
        
        Includes backlinks to all descendants (children, grandchildren, etc.) recursively.
        Also includes backlinks to all aliases of this node (and their descendants).
        
        Classes are stored in class_ids column, not as property links.
        """
        if not hasattr(self._link_repo, 'get_connection'):
            return []
        
        pool = self._link_repo.get_connection()
        
        # Get all descendants of the target node (includes children, grandchildren, etc.)
        descendant_ids = await self._node_repo.get_descendants(target_node_id, include_self=True)
        
        if not descendant_ids:
            # If no descendants found, just use the target node itself
            descendant_ids = [target_node_id]
        
        # Also include alias nodes and THEIR descendants
        # Aliases are pages whose aliased_id points to this node
        alias_rows = await pool.fetch("""
            SELECT id FROM node 
            WHERE aliased_id = $1 AND active = TRUE AND (is_deleted = FALSE OR is_deleted IS NULL)
        """, target_node_id)
        
        for alias_row in alias_rows:
            alias_id = alias_row['id']
            alias_descendants = await self._node_repo.get_descendants(alias_id, include_self=True)
            if alias_descendants:
                descendant_ids.extend(alias_descendants)
            else:
                descendant_ids.append(alias_id)
        
        # Get all links pointing to this node OR any of its descendants, with property info
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
            WHERE nl.target_id = ANY($1)
              AND (n.is_deleted = FALSE OR n.is_deleted IS NULL)
              AND (p.name IS NULL OR p.name NOT IN ('classes', 'extends'))
              AND (nl.is_inline_class IS NULL OR nl.is_inline_class = FALSE)
        """, descendant_ids)
        
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
        
        # Also get references from node-type properties (property_value_relation)
        # These are nodes that have a property value pointing to this target node or its descendants
        property_rows = await pool.fetch("""
            SELECT DISTINCT
                pvr.node_id as source_id,
                pvr.property_id,
                n.name as source_name,
                n.uuid as source_uuid,
                n.is_page as source_is_page,
                n.page_id as source_page_id,
                p.name as property_name,
                page.name as page_name,
                page.uuid as page_uuid
            FROM property_value_relation pvr
            JOIN property p ON pvr.property_id = p.id
            JOIN node n ON pvr.node_id = n.id
            LEFT JOIN node page ON n.page_id = page.id
            WHERE pvr.target_id = ANY($1)
              AND (n.is_deleted = FALSE OR n.is_deleted IS NULL)
              AND p.type = 'node'
              AND p.name NOT IN ('classes', 'extends')
        """, descendant_ids)
        
        for row in property_rows:
            # Create a pseudo NodeLink for property references
            # Use source_id as the node with the property
            link = NodeLink(
                id=None,  # No actual node_link record
                source_id=row['source_id'],
                target_id=target_node_id,
                position=0,
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
        
        # ── Detect text property context ──────────────────────────────
        # For text links from non-page blocks, check if the block (or an
        # ancestor) is the root block of a text-type property.  If so,
        # enrich the backlink with property provenance so the frontend
        # can display it like a property reference.
        
        text_link_backlinks = [
            b for b in backlinks
            if b.property_id is None and not b.source_is_page
        ]
        
        if text_link_backlinks:
            # Collect all unique source block IDs and their ancestors
            all_ancestor_ids: set[int] = set()
            source_ancestor_map: dict[int, list[int]] = {}
            
            for b in text_link_backlinks:
                ancestors = await self._node_repo.get_ancestors(
                    b.source_node_id, include_self=True
                )
                source_ancestor_map[b.source_node_id] = ancestors
                all_ancestor_ids.update(ancestors)
            
            if all_ancestor_ids:
                # Find which of these ancestor IDs are text property root blocks
                # i.e. they appear as target_id in property_value_relation
                # for a text-type property
                text_prop_rows = await pool.fetch("""
                    SELECT pvr.target_id AS root_block_id,
                           pvr.node_id   AS owner_id,
                           pvr.property_id,
                           p.name        AS property_name,
                           owner.name    AS owner_name,
                           owner.uuid    AS owner_uuid,
                           owner.is_page AS owner_is_page,
                           owner.page_id AS owner_page_id,
                           page.name     AS owner_page_name,
                           page.uuid     AS owner_page_uuid
                    FROM property_value_relation pvr
                    JOIN property p ON pvr.property_id = p.id
                    JOIN node owner ON pvr.node_id = owner.id
                    LEFT JOIN node page ON owner.page_id = page.id
                    WHERE pvr.target_id = ANY($1)
                      AND p.type = 'text'
                """, list(all_ancestor_ids))
                
                # Build lookup: root_block_id → text property info
                text_prop_lookup: dict[int, dict] = {}
                for tpr in text_prop_rows:
                    text_prop_lookup[tpr['root_block_id']] = {
                        'owner_id': tpr['owner_id'],
                        'owner_name': tpr['owner_name'],
                        'owner_uuid': tpr['owner_uuid'],
                        'owner_is_page': tpr['owner_is_page'],
                        'owner_page_id': tpr['owner_page_id'],
                        'owner_page_name': tpr['owner_page_name'],
                        'owner_page_uuid': tpr['owner_page_uuid'],
                        'property_id': tpr['property_id'],
                        'property_name': tpr['property_name'],
                        'root_block_id': tpr['root_block_id'],
                    }
                
                if text_prop_lookup:
                    for b in text_link_backlinks:
                        ancestors = source_ancestor_map.get(b.source_node_id, [])
                        # Check ancestors (including self) for a text property root
                        for anc_id in ancestors:
                            if anc_id in text_prop_lookup:
                                info = text_prop_lookup[anc_id]
                                b.property_id = info['property_id']
                                b.property_name = info['property_name']
                                b.text_property_root_block_id = info['root_block_id']
                                # Set source to the property owner (page/block
                                # that has the text property)
                                b.source_node_id = info['owner_id']
                                b.source_node_name = info['owner_name'] or ''
                                b.source_node_uuid = info['owner_uuid'] or ''
                                b.source_is_page = bool(info['owner_is_page'])
                                if info['owner_is_page']:
                                    b.source_page_id = info['owner_id']
                                    b.source_page_name = info['owner_name']
                                    b.source_page_uuid = info['owner_uuid']
                                else:
                                    b.source_page_id = info['owner_page_id']
                                    b.source_page_name = info['owner_page_name']
                                    b.source_page_uuid = info['owner_page_uuid']
                                # Rebuild breadcrumb with property context
                                b.breadcrumb_path = await self._build_breadcrumb_path(
                                    source_node_id=info['owner_id'],
                                    property_name=info['property_name'],
                                )
                                break
        
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
        
        # Get all links from all ancestors in one query
        rows = await pool.fetch("""
            SELECT DISTINCT nl.target_id
            FROM node_link nl
            WHERE nl.source_id = ANY($1)
        """, ancestor_ids)
        
        return [row['target_id'] for row in rows]
    
    async def update_classes_path(self, node_id: int) -> List[int]:
        """Compute and store the Classes Path for a node.
        
        Uses the node_path closure table for efficient ancestor lookup.
        
        Classes Path = ordered list of class node IDs inherited from ancestors'
        class_ids columns.
        
        This is separate from backlinks and is used for filtering/queries.
        """
        if not hasattr(self._link_repo, 'get_connection'):
            return []
        
        pool = self._link_repo.get_connection()
        classes_path = []
        
        # Get own classes from class_ids column
        node_row = await pool.fetchrow("""
            SELECT class_ids FROM node WHERE id = $1
        """, node_id)
        if node_row and node_row['class_ids']:
            classes_path.extend(node_row['class_ids'])
        
        # Get ancestor IDs using closure table (ordered from root to parent)
        try:
            ancestor_ids = await self._node_repo.get_ancestors(node_id, include_self=False)
        except Exception:
            ancestor_ids = []
        
        # Collect classes from all ancestors using class_ids column
        if ancestor_ids:
            rows = await pool.fetch("""
                SELECT DISTINCT unnest(class_ids) as class_id
                FROM node
                WHERE id = ANY($1) AND class_ids IS NOT NULL
            """, ancestor_ids)
            
            for row in rows:
                if row['class_id'] not in classes_path:
                    classes_path.append(row['class_id'])
        
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
