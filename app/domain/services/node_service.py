"""Node domain service.

Orchestrates node operations with link parsing and property management.
"""
from __future__ import annotations

from typing import Optional, List, Dict, Any, TYPE_CHECKING

from ..entities import Node, NodeCreateData, NodeUpdateData
from ..errors import SystemClassConstraintError, DatePageDeletionError
from ...db.schema.constants import SYSTEM_CLASS_UUIDS

if TYPE_CHECKING:
    from ..repositories import NodeRepository, PropertyRepository, LinkRepository
    from .link_service import LinkParsingService


# Date-related classes that are automatically assigned by the system (cannot be manually added/removed)
PROTECTED_DATE_CLASS_UUIDS = {
    SYSTEM_CLASS_UUIDS["year"],
    SYSTEM_CLASS_UUIDS["month"],
    SYSTEM_CLASS_UUIDS["day"],
}

# Set of all system class UUIDs for quick lookup
ALL_SYSTEM_CLASS_UUIDS = set(SYSTEM_CLASS_UUIDS.values())

# The 'class' class UUID - nodes with this UUID cannot have 'class' removed from them
CLASS_CLASS_UUID = SYSTEM_CLASS_UUIDS["class"]

# Mapping from class UUID to the node flag field name
CLASS_UUID_TO_FLAG = {
    SYSTEM_CLASS_UUIDS["class"]: "is_type",
    SYSTEM_CLASS_UUIDS["page"]: "is_page",
    SYSTEM_CLASS_UUIDS["day"]: "is_day",
    SYSTEM_CLASS_UUIDS["month"]: "is_month",
    SYSTEM_CLASS_UUIDS["year"]: "is_year",
    SYSTEM_CLASS_UUIDS["asset"]: "is_asset",
    SYSTEM_CLASS_UUIDS["template"]: "is_template",
    SYSTEM_CLASS_UUIDS["comment"]: "is_comment",
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
        page_class_id: int,
        classes_property_id: int,
    ):
        self._node_repo = node_repository
        self._property_repo = property_repository
        self._link_service = link_service
        self._page_class_id = page_class_id
        self._classes_property_id = classes_property_id
    
    async def create_node(
        self,
        data: NodeCreateData,
        user_id: Optional[int] = None,
    ) -> Node:
        """Create a new node.
        
        - Computes page_id for blocks
        - Parses content for links and inline classes
        - Applies tag properties (SuperTags)
        """
        # Create the node
        node = await self._node_repo.create(data, user_id)
        
        # Parse and store links and inline classes from content
        if node.name and node.id is not None:
            await self._link_service.update_node_links(node.id, node.name)
            await self._link_service.update_inline_classes(node.id, node.name)
        
        # Apply SuperClass properties if any classes have associated properties
        # TODO: Implement property value setting based on ClassProperty defaults
        # This requires determining the property class and using the appropriate
        # set_scalar_value, set_relation_value, or set_selection_value method
        # if node.id is not None:
        #     for class_id in data.classes:
        #         class_properties = await self._property_repo.get_class_properties(class_id)
        #         for tp in class_properties:
        #             default_value = (...)
        #             if default_value is not None:
        #                 await self._property_repo.set_*_value(...)
        
        return node
    
    async def create_page(
        self,
        name: str,
        icon: Optional[str] = None,
        color: Optional[str] = None,
        additional_classes: Optional[List[int]] = None,
        user_id: Optional[int] = None,
    ) -> Node:
        """Create a new page (node classed as 'page')."""
        classes = [self._page_class_id]
        if additional_classes:
            classes.extend(additional_classes)
        
        data = NodeCreateData(
            name=name,
            icon=icon,
            color=color,
            classes=classes,
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
        
        # Update classes path if parent changed (inherited classes may have changed)
        if new_parent_id != old_parent_id and node.id is not None:
            await self._link_service.update_classes_path(node.id)
        
        return node
    
    async def update_node(
        self,
        node_id: int,
        data: NodeUpdateData,
        user_id: Optional[int] = None,
    ) -> Optional[Node]:
        """Update an existing node.
        
        If name changes, re-parses links.
        If parent_id changes, updates classes path (inherited classes may change).
        """
        # Get the node before update to check if parent changed
        old_node = await self._node_repo.get_by_id(node_id)
        old_parent_id = old_node.parent_id if old_node else None
        
        node = await self._node_repo.update(node_id, data, user_id)
        if not node:
            return None
        
        # Re-parse links and inline classes if name changed
        if data.name is not None and node.id is not None:
            await self._link_service.update_node_links(node.id, node.name)
            await self._link_service.update_inline_classes(node.id, node.name)
        
        # Update classes path if parent changed (inherited classes may have changed)
        if data.parent_id is not None and data.parent_id != old_parent_id:
            if node.id is not None:
                await self._link_service.update_classes_path(node.id)
        
        return node
    
    async def delete_node(self, node_id: int) -> bool:
        """Delete a node and all its children.
        
        Before deleting, updates all nodes that link to this node:
        - [[nodeId]] links are replaced with the node's name
        - {{nodeId}} inline class references are replaced with the node's name
        - Property class/tag references are removed
        
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
                node_class = "month" if node.is_month else "year"
                raise DatePageDeletionError(node_class, day_count)
        
        # Get all backlinks to this node (from [[nodeId]] links)
        backlinks = await self._link_service.get_backlinks(node_id)
        
        # Track nodes we've updated to avoid double-processing
        updated_nodes = set()
        
        # Update each source node to remove/replace the link
        for link in backlinks:
            source_node = await self._node_repo.get_by_id(link.source_node_id)
            if not source_node or not source_node.name:
                continue
            
            # Replace the link in the source node's content
            updated_content = await self._remove_link_from_content(
                source_node.name,
                node,
                "page"  # link_type is no longer used but kept for signature compatibility
            )
            
            if updated_content != source_node.name:
                # Update without re-parsing links (to avoid infinite recursion)
                await self._node_repo.update(
                    link.source_node_id,
                    NodeUpdateData(name=updated_content)
                )
                updated_nodes.add(link.source_node_id)
        
        # Also handle inline class references ({{nodeId}})
        await self._replace_inline_class_references(node, updated_nodes)
        
        # Remove this node from any class/tag properties
        await self._remove_node_from_class_tag_properties(node_id)
        
        # Now delete the node itself
        return await self._node_repo.delete(node_id)
    
    async def _replace_inline_class_references(self, node: Node, already_updated: set) -> None:
        """Replace inline class references ({{nodeId}}) with the node's name.
        
        Args:
            node: The node being deleted
            already_updated: Set of node IDs already processed (to avoid double updates)
        """
        if not self._link_service._inline_class_repo:
            return
        
        # Get all nodes that reference this node as an inline class
        inline_refs = await self._link_service._inline_class_repo.get_class_references(node.id)
        
        for ref in inline_refs:
            if ref.node_id in already_updated:
                # Already updated from backlinks processing
                continue
            
            source_node = await self._node_repo.get_by_id(ref.node_id)
            if not source_node or not source_node.name:
                continue
            
            # Replace {{nodeId}} with the node's name
            updated_content = await self._remove_link_from_content(
                source_node.name,
                node,
                "class"
            )
            
            if updated_content != source_node.name:
                await self._node_repo.update(
                    ref.node_id,
                    NodeUpdateData(name=updated_content)
                )
    
    async def _remove_link_from_content(
        self,
        content: str,
        target_node: Node,
        link_class: str
    ) -> str:
        """Remove or replace a link in content with plain text.
        
        Links are stored as [[nodeId]] format, inline classes as {{classId}}.
        Both are replaced with the node's name.
        """
        import re
        
        result = content
        
        # Replace [[nodeId]] links with the node's name
        link_pattern = re.compile(r'\[\[' + str(target_node.id) + r'\]\]')
        result = link_pattern.sub(target_node.name or '', result)
        
        # Also replace {{nodeId}} inline class references with the node's name
        class_pattern = re.compile(r'\{\{' + str(target_node.id) + r'\}\}')
        result = class_pattern.sub(target_node.name or '', result)
        
        return result
    
    async def _remove_node_from_class_tag_properties(self, node_id: int) -> None:
        """Remove a node from any class/tag property values where it's referenced.
        
        When a node used as a class or tag is deleted, remove it from all nodes
        that reference it. The inline text (if any) remains.
        """
        # Find all property values that reference this node
        # This would require scanning all nodes with class/tag properties
        # For now, we'll rely on the database to handle this via foreign key cascades
        # TODO: Implement proper cleanup of class/tag references
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
    
    async def add_class(self, node_id: int, class_node_id: int, *, _system_call: bool = False) -> bool:
        """Add a class to a node.
        
        Args:
            node_id: The node to add the class to
            class_node_id: The class node ID to add
            _system_call: Internal flag - if True, bypasses date class protection (for system endpoints)
        
        Raises:
            SystemClassConstraintError: If trying to add a protected date class (day, month, year)
        """
        # Check if the class being added is a protected date class
        class_node = await self._node_repo.get_by_id(class_node_id)
        if class_node and class_node.uuid in PROTECTED_DATE_CLASS_UUIDS and not _system_call:
            raise SystemClassConstraintError(
                f"Cannot manually add '{class_node.name}' class. Date classes (day, month, year) are managed by the system."
            )
        
        # Get current classes by fetching relation values for the classes property
        existing_values = await self._property_repo.get_relation_values(node_id, self._classes_property_id)
        existing_class_ids = [v.target_node_id for v in existing_values]
        
        if class_node_id in existing_class_ids:
            return False  # Already has this class
        
        # Add the class using set_relation_value
        await self._property_repo.set_relation_value(
            node_id, self._classes_property_id, class_node_id
        )
        
        # Update the corresponding flag if this is a system class with a flag
        if class_node and class_node.uuid in CLASS_UUID_TO_FLAG:
            flag_name = CLASS_UUID_TO_FLAG[class_node.uuid]
            update_data = NodeUpdateData()
            setattr(update_data, flag_name, True)
            await self._node_repo.update(node_id, update_data)
        
        # Apply SuperClass properties
        class_properties = await self._property_repo.get_class_properties(class_node_id)
        for tp in class_properties:
            default_value = (
                tp.default_integer or tp.default_float or tp.default_text or
                tp.default_boolean or tp.default_node_id or tp.default_selection_id
            )
            if default_value is not None:
                # TODO: Set property values based on class
                pass
        
        return True
    
    # Alias for backwards compatibility
    async def add_type(self, node_id: int, type_node_id: int, *, _system_call: bool = False) -> bool:
        """Alias for add_class for backwards compatibility."""
        return await self.add_class(node_id, type_node_id, _system_call=_system_call)
    
    async def remove_class(self, node_id: int, class_node_id: int) -> bool:
        """Remove a class from a node.
        
        Raises:
            SystemClassConstraintError: If trying to remove a protected date class (day, month, year)
                                       or 'class' from a system class node
        """
        # Check if the class being removed is a protected date class
        class_node = await self._node_repo.get_by_id(class_node_id)
        if class_node and class_node.uuid in PROTECTED_DATE_CLASS_UUIDS:
            raise SystemClassConstraintError(
                f"Cannot remove '{class_node.name}' class. Date classes (day, month, year) are managed by the system."
            )
        
        # Check if trying to remove 'class' from a system class node
        if class_node and class_node.uuid == CLASS_CLASS_UUID:
            # Get the node we're removing the class from
            node = await self._node_repo.get_by_id(node_id)
            if node and node.uuid in ALL_SYSTEM_CLASS_UUIDS:
                raise SystemClassConstraintError(
                    f"Cannot remove 'class' from system class '{node.name}'. System classes must remain as classes."
                )
        
        # Get relation values for the classes property
        values = await self._property_repo.get_relation_values(node_id, self._classes_property_id)
        
        for val in values:
            if val.target_node_id == class_node_id:
                # Remove this specific relation value
                if val.id is not None:
                    await self._property_repo.remove_relation_value(val.id)
                
                # Update the corresponding flag if this is a system class with a flag
                if class_node and class_node.uuid in CLASS_UUID_TO_FLAG:
                    flag_name = CLASS_UUID_TO_FLAG[class_node.uuid]
                    update_data = NodeUpdateData()
                    setattr(update_data, flag_name, False)
                    await self._node_repo.update(node_id, update_data)
                
                return True
        
        return False  # Class was not assigned to this node
    
    # Alias for backwards compatibility
    async def remove_type(self, node_id: int, type_node_id: int) -> bool:
        """Alias for remove_class for backwards compatibility."""
        return await self.remove_class(node_id, type_node_id)
    
    async def get_node_classes(self, node_id: int) -> List[Node]:
        """Get all classes applied to a node."""
        # Get relation values directly from the classes property
        relation_values = await self._property_repo.get_relation_values(
            node_id, self._classes_property_id
        )
        
        classes = []
        for val in relation_values:
            if val.target_node_id:
                class_node = await self._node_repo.get_by_id(val.target_node_id)
                if class_node:
                    classes.append(class_node)
        
        return classes
    
    # Alias for backwards compatibility
    async def get_node_types(self, node_id: int) -> List[Node]:
        """Alias for get_node_classes for backwards compatibility."""
        return await self.get_node_classes(node_id)

    async def archive_node(self, node_id: int, user_id: Optional[int] = None) -> Optional[Node]:
        """Archive a node (set active to false)."""
        return await self._node_repo.set_active(node_id, False, user_id)

    async def unarchive_node(self, node_id: int, user_id: Optional[int] = None) -> Optional[Node]:
        """Unarchive a node (set active to true)."""
        return await self._node_repo.set_active(node_id, True, user_id)

    async def get_archived_pages(self) -> List[Node]:
        """Get all archived pages."""
        return await self._node_repo.get_archived_pages()
