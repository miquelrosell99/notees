"""Node domain service.

Orchestrates node operations with link parsing and property management.
"""
from __future__ import annotations

from typing import Optional, List, Dict, Any, TYPE_CHECKING

from ..entities import Node, NodeCreateData, NodeUpdateData

if TYPE_CHECKING:
    from ..repositories import NodeRepository, PropertyRepository, LinkRepository
    from .link_service import LinkParsingService


class NodeService:
    """Domain service for node operations."""
    
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
        if node.id is not None:
            for type_id in data.types:
                type_properties = await self._property_repo.get_type_properties(type_id)
                for tp in type_properties:
                    # Get default value based on property type
                    default_value = (
                        tp.default_integer or tp.default_float or tp.default_text or
                        tp.default_boolean or tp.default_node_id or tp.default_selection_id
                    )
                    if default_value is not None:
                        await self._property_repo.set_node_property(
                            node.id, tp.property_id, default_value, tp.sequence
                        )
        
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
        """
        node = await self._node_repo.get_by_id(node_id)
        if not node:
            return False
        
        # Get all backlinks to this node
        backlinks = await self._link_service.get_backlinks(node_id, include_inherited=False)
        
        # Update each source node to remove/replace the link
        for link in backlinks:
            source_node = await self._node_repo.get_by_id(link.source_node_id)
            if not source_node or not source_node.name:
                continue
            
            # Replace the link in the source node's content
            updated_content = await self._remove_link_from_content(
                source_node.name,
                node,
                link.link_type
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
    
    async def add_type(self, node_id: int, type_node_id: int) -> bool:
        """Add a type to a node."""
        # Get current types by fetching relation values for the types property
        existing_values = await self._property_repo.get_relation_values(node_id, self._types_property_id)
        existing_type_ids = [v.target_node_id for v in existing_values]
        
        if type_node_id in existing_type_ids:
            return False  # Already has this type
        
        # Add the type using set_relation_value
        max_order = max((v.order for v in existing_values), default=-1)
        await self._property_repo.set_relation_value(
            node_id, self._types_property_id, type_node_id, max_order + 1
        )
        
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
        """Remove a type from a node."""
        # Get relation values for the types property
        values = await self._property_repo.get_relation_values(node_id, self._types_property_id)
        
        for val in values:
            if val.target_node_id == type_node_id:
                # Remove this specific relation value
                await self._property_repo.remove_relation_value(val.id)
                return True
        
        return False  # Type was not assigned to this node
    
    async def get_node_types(self, node_id: int) -> List[Node]:
        """Get all types applied to a node."""
        properties = await self._property_repo.get_node_properties(node_id)
        type_ids = []
        for p in properties:
            if p.property_id == self._types_property_id:
                # Values are PropertyValueRelation objects with target_node_id
                for val in p.get_values():
                    if hasattr(val, 'target_node_id') and val.target_node_id:
                        type_ids.append(val.target_node_id)
        
        types = []
        for type_id in type_ids:
            type_node = await self._node_repo.get_by_id(type_id)
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
