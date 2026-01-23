"""Node domain service.

Orchestrates node operations with link parsing and property management.
"""
from __future__ import annotations

from typing import Optional, List, Dict, Any, TYPE_CHECKING

from ..entities import Node, NodeCreateData, NodeUpdateData
from ..errors import SystemTypeConstraintError, DatePageDeletionError
from ...db.schema.constants import SYSTEM_TYPE_UUIDS

if TYPE_CHECKING:
    from ..repositories import NodeRepository, PropertyRepository, LinkRepository
    from .link_service import LinkParsingService


# Date-related types that are automatically assigned by the system (cannot be manually added/removed)
PROTECTED_DATE_TYPE_UUIDS = {
    SYSTEM_TYPE_UUIDS["year"],
    SYSTEM_TYPE_UUIDS["month"],
    SYSTEM_TYPE_UUIDS["day"],
}

# Set of all system type UUIDs for quick lookup
ALL_SYSTEM_TYPE_UUIDS = set(SYSTEM_TYPE_UUIDS.values())

# The 'type' type UUID - nodes with this UUID cannot have 'type' removed from them
TYPE_TYPE_UUID = SYSTEM_TYPE_UUIDS["type"]

# Mapping from type UUID to the node flag field name
TYPE_UUID_TO_FLAG = {
    SYSTEM_TYPE_UUIDS["type"]: "is_type",
    SYSTEM_TYPE_UUIDS["page"]: "is_page",
    SYSTEM_TYPE_UUIDS["day"]: "is_day",
    SYSTEM_TYPE_UUIDS["month"]: "is_month",
    SYSTEM_TYPE_UUIDS["year"]: "is_year",
    SYSTEM_TYPE_UUIDS["asset"]: "is_asset",
    SYSTEM_TYPE_UUIDS["template"]: "is_template",
    SYSTEM_TYPE_UUIDS["comment"]: "is_comment",
}


class NodeService:
    """Domain service for node operations."""
    
    # Optional attributes set by routers for direct pool/graph access
    _pool: Any = None
    _graph_id: Optional[int] = None
    
    def __init__(
        self,
        node_repository: NodeRepository,
        property_repository: PropertyRepository,
        link_service: LinkParsingService,
        page_type_id: int,
        types_property_id: int,
    ):
        self._node_repo = node_repository
        self._property_repo = property_repository
        self._link_service = link_service
        self._page_type_id = page_type_id
        self._types_property_id = types_property_id
    
    async def create_node(
        self,
        data: NodeCreateData,
        user_id: Optional[int] = None,
    ) -> Node:
        """Create a new node.
        
        - Computes page_id for blocks
        - Parses content for links and inline types
        - Applies tag properties (SuperTags)
        """
        # Create the node
        node = await self._node_repo.create(data, user_id)
        
        # Parse and store links and inline types from content
        if node.name and node.id is not None:
            await self._link_service.update_node_links(node.id, node.name)
            await self._link_service.update_inline_types(node.id, node.name)
        
        # Apply SuperType properties if any types have associated properties
        # TODO: Implement property value setting based on TypeProperty defaults
        # This requires determining the property type and using the appropriate
        # set_scalar_value, set_relation_value, or set_selection_value method
        # if node.id is not None:
        #     for type_id in data.types:
        #         type_properties = await self._property_repo.get_type_properties(type_id)
        #         for tp in type_properties:
        #             default_value = (...)
        #             if default_value is not None:
        #                 await self._property_repo.set_*_value(...)
        
        return node
    
    async def create_page(
        self,
        name: str,
        icon: Optional[str] = None,
        color: Optional[str] = None,
        additional_types: Optional[List[int]] = None,
        user_id: Optional[int] = None,
    ) -> Node:
        """Create a new page (node typed as 'page')."""
        types = [self._page_type_id]
        if additional_types:
            types.extend(additional_types)
        
        data = NodeCreateData(
            name=name,
            icon=icon,
            color=color,
            types=types,
            is_page=True,
        )
        return await self.create_node(data, user_id)
    
    async def create_block(
        self,
        name: str,
        parent_id: int,
        sequence: int = 0,
        user_id: Optional[int] = None,
    ) -> Node:
        """Create a new block (child node)."""
        data = NodeCreateData(
            name=name,
            parent_id=parent_id,
            sequence=sequence,
        )
        return await self.create_node(data, user_id)
    
    async def move_node(
        self,
        node_id: int,
        new_parent_id: int,
        new_sequence: int,
        user_id: Optional[int] = None,
    ) -> Optional[Node]:
        """Move a node to a new parent and/or position.
        
        This properly handles sibling resequencing to maintain order consistency.
        """
        # Get the node before move to check if parent changed
        old_node = await self._node_repo.get_by_id(node_id)
        if not old_node:
            return None
        
        old_parent_id = old_node.parent_id
        
        # Use dedicated move method for proper resequencing
        node = await self._node_repo.move(node_id, new_parent_id, new_sequence, user_id)
        if not node:
            return None
        
        # Update types path if parent changed (inherited types may have changed)
        if new_parent_id != old_parent_id and node.id is not None:
            await self._link_service.update_types_path(node.id)
        
        return node
    
    async def update_node(
        self,
        node_id: int,
        data: NodeUpdateData,
        user_id: Optional[int] = None,
    ) -> Optional[Node]:
        """Update an existing node.
        
        If name changes, re-parses links.
        If parent_id changes, updates types path (inherited types may change).
        """
        # Get the node before update to check if parent changed
        old_node = await self._node_repo.get_by_id(node_id)
        old_parent_id = old_node.parent_id if old_node else None
        
        node = await self._node_repo.update(node_id, data, user_id)
        if not node:
            return None
        
        # Re-parse links and inline types if name changed
        if data.name is not None and node.id is not None:
            await self._link_service.update_node_links(node.id, node.name)
            await self._link_service.update_inline_types(node.id, node.name)
        
        # Update types path if parent changed (inherited types may have changed)
        if data.parent_id is not None and data.parent_id != old_parent_id:
            if node.id is not None:
                await self._link_service.update_types_path(node.id)
        
        return node
    
    async def delete_node(self, node_id: int) -> bool:
        """Delete a node and all its children.
        
        Before deleting, updates all nodes that link to this node:
        - [[Page Name]] links are replaced with just "Page Name"
        - ((uuid)) links are replaced with the block's content text
        - Type/tag references are removed from properties but leave inline text
        
        Works for both active and archived nodes.
        
        Raises:
            DatePageDeletionError: If trying to delete a month/year page that has active day children
        """
        # Get node including archived ones (bypassing active=TRUE filter)
        pool = self._node_repo.get_connection()
        row = await pool.fetchrow(
            "SELECT * FROM node WHERE id = $1 AND graph_id = $2",
            node_id, self._graph_id
        )
        if not row:
            return False
        
        node = self._node_repo._row_to_node(row)
        
        # Prevent deletion of month/year pages that have active day children
        if node.is_month or node.is_year:
            day_count = await self._count_active_day_descendants(node_id)
            if day_count > 0:
                node_type = "month" if node.is_month else "year"
                raise DatePageDeletionError(node_type, day_count)
        
        # Get all backlinks to this node
        backlinks = await self._link_service.get_backlinks(node_id)
        
        # Update each source node to remove/replace the link
        for link in backlinks:
            source_node = await self._node_repo.get_by_id(link.source_node_id)
            if not source_node or not source_node.name:
                continue
            
            # Determine link type based on whether target is a page or block
            link_type = "page" if node.is_page else "block"
            
            # Replace the link in the source node's content
            updated_content = await self._remove_link_from_content(
                source_node.name,
                node,
                link_type
            )
            
            if updated_content != source_node.name:
                # Update without re-parsing links (to avoid infinite recursion)
                await self._node_repo.update(
                    link.source_node_id,
                    NodeUpdateData(name=updated_content)
                )
        
        # Remove this node from any type/tag properties
        await self._remove_node_from_type_tag_properties(node_id)
        
        # Now delete the node itself
        return await self._node_repo.delete(node_id)
    
    async def _remove_link_from_content(
        self,
        content: str,
        target_node: Node,
        link_type: str
    ) -> str:
        """Remove or replace a link in content with plain text.
        
        For page links: [[Page Name]] -> Page Name
        For block links: ((uuid)) -> (content text or empty)
        """
        import re
        
        if link_type == 'page':
            # Replace [[Page Name]] with just Page Name
            pattern = re.compile(r'\[\[' + re.escape(target_node.name or '') + r'\]\]')
            return pattern.sub(target_node.name or '', content)
        else:
            # Replace ((uuid)) with the block's text content or empty
            pattern = re.compile(r'\(\(' + re.escape(target_node.uuid or '') + r'\)\)')
            return pattern.sub(target_node.name or '', content)
    
    async def _remove_node_from_type_tag_properties(self, node_id: int) -> None:
        """Remove a node from any type/tag property values where it's referenced.
        
        When a node used as a type or tag is deleted, remove it from all nodes
        that reference it. The inline text (if any) remains.
        """
        # Find all property values that reference this node
        # This would require scanning all nodes with type/tag properties
        # For now, we'll rely on the database to handle this via foreign key cascades
        # TODO: Implement proper cleanup of type/tag references
        pass
    
    async def _count_active_day_descendants(self, node_id: int) -> int:
        """Count active day pages that are descendants of this node.
        
        Used to prevent deletion of month/year pages that have active daily pages.
        
        Args:
            node_id: The ID of the month or year node to check
            
        Returns:
            Number of active day pages that are descendants of this node
        """
        if self._pool is None or self._graph_id is None:
            return 0
        
        async with self._pool.acquire() as conn:
            # Use closure table (node_path) to find all descendants, then count day pages
            row = await conn.fetchrow("""
                SELECT COUNT(*) as day_count 
                FROM node_path np
                JOIN node n ON n.id = np.descendant_id
                WHERE np.ancestor_id = $1 
                  AND np.depth > 0
                  AND n.graph_id = $2 
                  AND n.active = TRUE
                  AND n.is_day = TRUE
            """, node_id, self._graph_id)
            
            return row['day_count'] if row else 0
    
    async def get_node(self, node_id: int) -> Optional[Node]:
        """Get a node by ID."""
        return await self._node_repo.get_by_id(node_id)
    
    async def get_node_by_uuid(self, uuid: str) -> Optional[Node]:
        """Get a node by UUID."""
        return await self._node_repo.get_by_uuid(uuid)
    
    async def get_node_with_properties(self, node_id: int) -> Optional[Dict[str, Any]]:
        """Get a node with all its property values."""
        node = await self._node_repo.get_by_id(node_id)
        if not node:
            return None
        
        properties = await self._property_repo.get_node_properties(node_id)
        
        return {
            "node": node,
            "properties": properties,
        }
    
    async def get_all_pages(self) -> List[Node]:
        """Get all pages."""
        return await self._node_repo.get_all_pages()
    
    async def get_page_content(self, page_id: int) -> Optional[Dict[str, Any]]:
        """Get a page with all its blocks and properties."""
        page = await self._node_repo.get_by_id(page_id)
        if not page:
            return None
        
        # Get all blocks belonging to this page
        blocks = await self._node_repo.get_page_content(page_id)
        
        # Get properties for page
        page_properties = await self._property_repo.get_node_properties(page_id)
        
        # Get backlinks
        backlinks = await self._link_service.get_backlinks(page_id)
        
        return {
            "page": page,
            "blocks": blocks,
            "properties": page_properties,
            "backlinks": backlinks,
        }
    
    async def search(self, query: str, limit: int = 50) -> List[Node]:
        """Search nodes by name."""
        return await self._node_repo.search(query, limit)
    
    async def add_type(self, node_id: int, type_node_id: int, *, _system_call: bool = False) -> bool:
        """Add a type to a node.
        
        Args:
            node_id: The node to add the type to
            type_node_id: The type node ID to add
            _system_call: Internal flag - if True, bypasses date type protection (for system endpoints)
        
        Raises:
            SystemTypeConstraintError: If trying to add a protected date type (day, month, year)
        """
        # Check if the type being added is a protected date type
        type_node = await self._node_repo.get_by_id(type_node_id)
        if type_node and type_node.uuid in PROTECTED_DATE_TYPE_UUIDS and not _system_call:
            raise SystemTypeConstraintError(
                f"Cannot manually add '{type_node.name}' type. Date types (day, month, year) are managed by the system."
            )
        
        # Get current types by fetching relation values for the types property
        existing_values = await self._property_repo.get_relation_values(node_id, self._types_property_id)
        existing_type_ids = [v.target_node_id for v in existing_values]
        
        if type_node_id in existing_type_ids:
            return False  # Already has this type
        
        # Add the type using set_relation_value
        await self._property_repo.set_relation_value(
            node_id, self._types_property_id, type_node_id
        )
        
        # Update the corresponding flag if this is a system type with a flag
        if type_node and type_node.uuid in TYPE_UUID_TO_FLAG:
            flag_name = TYPE_UUID_TO_FLAG[type_node.uuid]
            update_data = NodeUpdateData()
            setattr(update_data, flag_name, True)
            await self._node_repo.update(node_id, update_data)
        
        # Apply SuperType properties
        type_properties = await self._property_repo.get_type_properties(type_node_id)
        for tp in type_properties:
            default_value = (
                tp.default_integer or tp.default_float or tp.default_text or
                tp.default_boolean or tp.default_node_id or tp.default_selection_id
            )
            if default_value is not None:
                # TODO: Set property values based on type
                pass
        
        return True
    
    async def remove_type(self, node_id: int, type_node_id: int) -> bool:
        """Remove a type from a node.
        
        Raises:
            SystemTypeConstraintError: If trying to remove a protected date type (day, month, year)
                                       or 'type' from a system type node
        """
        # Check if the type being removed is a protected date type
        type_node = await self._node_repo.get_by_id(type_node_id)
        if type_node and type_node.uuid in PROTECTED_DATE_TYPE_UUIDS:
            raise SystemTypeConstraintError(
                f"Cannot remove '{type_node.name}' type. Date types (day, month, year) are managed by the system."
            )
        
        # Check if trying to remove 'type' from a system type node
        if type_node and type_node.uuid == TYPE_TYPE_UUID:
            # Get the node we're removing the type from
            node = await self._node_repo.get_by_id(node_id)
            if node and node.uuid in ALL_SYSTEM_TYPE_UUIDS:
                raise SystemTypeConstraintError(
                    f"Cannot remove 'type' from system type '{node.name}'. System types must remain as types."
                )
        
        # Get relation values for the types property
        values = await self._property_repo.get_relation_values(node_id, self._types_property_id)
        
        for val in values:
            if val.target_node_id == type_node_id:
                # Remove this specific relation value
                if val.id is not None:
                    await self._property_repo.remove_relation_value(val.id)
                
                # Update the corresponding flag if this is a system type with a flag
                if type_node and type_node.uuid in TYPE_UUID_TO_FLAG:
                    flag_name = TYPE_UUID_TO_FLAG[type_node.uuid]
                    update_data = NodeUpdateData()
                    setattr(update_data, flag_name, False)
                    await self._node_repo.update(node_id, update_data)
                
                return True
        
        return False  # Type was not assigned to this node
    
    async def get_node_types(self, node_id: int) -> List[Node]:
        """Get all types applied to a node."""
        # Get relation values directly from the types property
        relation_values = await self._property_repo.get_relation_values(
            node_id, self._types_property_id
        )
        
        types = []
        for val in relation_values:
            if val.target_node_id:
                type_node = await self._node_repo.get_by_id(val.target_node_id)
                if type_node:
                    types.append(type_node)
        
        return types

    async def archive_node(self, node_id: int, user_id: Optional[int] = None) -> Optional[Node]:
        """Archive a node (set active to false)."""
        return await self._node_repo.set_active(node_id, False, user_id)

    async def unarchive_node(self, node_id: int, user_id: Optional[int] = None) -> Optional[Node]:
        """Unarchive a node (set active to true)."""
        return await self._node_repo.set_active(node_id, True, user_id)

    async def get_archived_pages(self) -> List[Node]:
        """Get all archived pages."""
        return await self._node_repo.get_archived_pages()
