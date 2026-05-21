"""Node domain service.

Orchestrates node operations with link parsing and property management.
"""
from __future__ import annotations

from typing import Optional, List, Dict, Any, TYPE_CHECKING

from ..entities import Node, NodeCreateData, NodeUpdateData
from ..errors import SystemClassConstraintError, DatePageDeletionError, DuplicateNodeError, PermissionDeniedError
from ..permissions import PermissionChecker
from ..validation import validate_node_create, validate_node_update
from ..stringify_ast import parse_ast, serialize_ast, stringify_ast, ParseMode, StringifyMode, StringifyOptions
from ...db.schema.constants import SYSTEM_CLASS_UUIDS
from ...db.connection import get_workspace_uuid
from ...logging_config import get_logger
from .class_management_service import ClassManagementService

if TYPE_CHECKING:
    import asyncpg
    from ..repositories import NodeRepository, PropertyRepository, LinkRepository
    from .link_service import LinkParsingService

logger = get_logger(__name__)


# Maximum allowed hierarchy depth to prevent pathological trees
MAX_HIERARCHY_DEPTH = 100



class NodeService:
    """Domain service for node operations."""
    
    # Optional attributes set by routers for direct pool/workspace access
    _pool: Any = None
    _workspace_id: Optional[int] = None
    _user_id: Optional[int] = None
    _permissions: Optional[PermissionChecker] = None
    
    def __init__(
        self,
        node_repository: NodeRepository,
        property_repository: PropertyRepository,
        link_service: LinkParsingService,
        page_class_id: int,
        pool: Optional[asyncpg.Pool] = None,
        workspace_id: Optional[int] = None,
        user_id: Optional[int] = None,
    ):
        self._node_repo = node_repository
        self._property_repo = property_repository
        self._link_service = link_service
        self._page_class_id = page_class_id
        self._pool = pool
        self._workspace_id = workspace_id
        self._user_id = user_id
        self._class_service = ClassManagementService(pool, workspace_id, node_repository, property_repository)

    # ── Public properties ──────────────────────────────────────────────────

    @property
    def pool(self):
        """Connection pool for direct query access."""
        return self._pool

    @property
    def workspace_id(self) -> Optional[int]:
        """Workspace ID for this service instance."""
        return self._workspace_id

    @property
    def page_class_id(self) -> Optional[int]:
        """Page class node ID."""
        return self._page_class_id

    @property
    def property_repo(self):
        """Property repository (used by property routers that need repo-level CRUD)."""
        return self._property_repo

    @property
    def permissions(self) -> PermissionChecker:
        if self._permissions is None:
            if self._pool is None or self._user_id is None:
                raise RuntimeError("Pool and user ID required for permission checks")
            self._permissions = PermissionChecker(self._pool, self._user_id)
        return self._permissions

    # ── Public delegation methods ──────────────────────────────────────────

    async def get_node_children(self, node_id: int) -> List[Node]:
        """Get direct children of a node."""
        return await self._node_repo.get_children(node_id)

    async def get_node_descendants(self, node_id: int) -> List[Node]:
        """Get all descendants of a node (flat list, ordered by depth then sequence)."""
        if hasattr(self._node_repo, 'get_descendants'):
            descendant_ids = await self._node_repo.get_descendants(node_id, include_self=False)
            if descendant_ids:
                return await self._node_repo.get_by_ids(descendant_ids)
            return []
        # Fallback: BFS traversal
        result: List[Node] = []
        to_process = [node_id]
        while to_process:
            current_id = to_process.pop(0)
            children = await self._node_repo.get_children(current_id)
            result.extend(children)
            to_process.extend(c.id for c in children if c.id is not None)
        return result

    async def get_nodes_typed_with(self, class_id: int) -> List[Node]:
        """Get all nodes that have this class assigned."""
        return await self._node_repo.get_typed_with(class_id)

    async def get_nodes_by_ids(self, ids: List[int]) -> List[Node]:
        """Get multiple nodes by ID list."""
        return await self._node_repo.get_by_ids(ids)

    async def get_node_breadcrumbs(self, node_id: int) -> List[Node]:
        """Get ancestor chain from root to node's immediate parent."""
        return await self._node_repo.get_breadcrumbs(node_id)

    async def get_node_properties(self, node_id: int):
        """Get all property values for a node."""
        return await self._property_repo.get_all_property_values(node_id)

    async def get_nodes_properties_batch(self, node_ids: List[int]):
        """Get property values for multiple nodes in a single batch."""
        return await self._property_repo.get_all_property_values_batch(node_ids)

    async def get_backlinks(self, node_id: int):
        """Get all backlinks pointing to this node."""
        return await self._link_service.get_backlinks(node_id)

    async def get_inline_classes_for_node(self, node_id: int):
        """Get all inline class references parsed from this node's content."""
        return await self._link_service.get_inline_classes_for_node(node_id)

    async def update_node_links(self, node_id: int, content: str):
        """Parse and sync [[link]] references in content for this node."""
        return await self._link_service.update_node_links(node_id, content)

    async def update_inline_classes(self, node_id: int, content: str):
        """Parse and sync {{class}} inline type references in content for this node."""
        return await self._link_service.update_inline_classes(node_id, content)

    def row_to_node(self, row) -> Node:
        """Convert a raw DB row to a Node entity."""
        return self._node_repo.row_to_node(row)

    async def create_raw_node(self, data: NodeCreateData, uuid: Optional[str] = None) -> Node:
        """Create a node directly via repository, bypassing link parsing.

        Used for system-managed nodes (date pages, assets) where the UUID is
        predetermined and normal validation / link-parsing is not needed.
        """
        if self._user_id:
            await self.permissions.require_workspace_create(self._workspace_id)
        return await self._node_repo.create(data, uuid=uuid)

    async def _compute_flags_from_classes(self, class_ids: List[int]) -> Dict[str, bool]:
        """Delegate to ClassManagementService."""
        return await self._class_service.compute_flags_from_classes(class_ids)

    async def _update_flags_from_classes(self, node_id: int, class_ids: List[int]) -> None:
        """Delegate to ClassManagementService."""
        await self._class_service.update_flags_from_classes(node_id, class_ids)
    
    async def _validate_page_name_uniqueness(
        self,
        name: str,
        parent_id: Optional[int],
        classes: List[int],
        exclude_node_id: Optional[int] = None,
    ) -> None:
        """Validate that a page name is unique per class within the same parent.
        
        A page name is unique within (workspace, parent) for each class it has.
        Example:
        - "EXAMPLE PAGE" with classes [task, meeting] exists
        - Cannot create "EXAMPLE PAGE" with [task] → conflicts on "task"
        - Cannot create "EXAMPLE PAGE" with [task, urgent] → conflicts on "task"  
        - CAN create "EXAMPLE PAGE" with [project] → no class overlap
        - CAN create "EXAMPLE PAGE" with [project, meeting] → "project" is new
        
        Args:
            name: Page name to check
            parent_id: Parent node ID (None for root pages)
            classes: List of class node IDs this page will have
            exclude_node_id: Node ID to exclude from check (for updates)
            
        Raises:
            DuplicateNodeError: If a page with this name exists with any overlapping class
        """
        if not classes:
            # Unclassed pages can't conflict with anything
            return
        
        rows = await self._node_repo.find_page_by_name(name, parent_id)
        if exclude_node_id:
            rows = [r for r in rows if r['id'] != exclude_node_id]
        
        if not rows:
            return
        
        # Group by node to get each existing page's classes
        existing_pages: Dict[int, List[tuple]] = {}
        for row in rows:
            node_id = row['id']
            if node_id not in existing_pages:
                existing_pages[node_id] = []
            if row['class_id']:
                existing_pages[node_id].append((row['class_id'], row['class_name']))
        
        # Check each existing page for class overlap
        for node_id, existing_classes in existing_pages.items():
            existing_class_ids = {c[0] for c in existing_classes}
            overlap = set(classes) & existing_class_ids
            
            if overlap:
                # Found conflict - get class names for error message
                conflicting_class_names = [
                    c[1] for c in existing_classes if c[0] in overlap
                ]
                raise DuplicateNodeError(name, conflicting_class_names)
    
    async def _create_hierarchical_page(
        self,
        data: NodeCreateData,
        user_id: Optional[int] = None,
    ) -> Node:
        """Create a page with hierarchical path (name contains '/').
        
        For a name like "Projects/Work/Q1 Planning", this will:
        1. Create or find "Projects" as a root page
        2. Create or find "Work" as a child of "Projects"
        3. Create "Q1 Planning" as a child of "Work"
        4. Return the leaf node
        
        All intermediate pages inherit the classes from the original request.
        """
        if not data.name or '/' not in data.name:
            raise ValueError("Name must contain '/' for hierarchical creation")
        
        # Split the path into segments
        segments = [s.strip() for s in data.name.split('/') if s.strip()]
        
        if not segments:
            raise ValueError("Empty path after splitting")
        
        # Use provided classes or default to page class
        classes = data.classes if data.classes else [self._page_class_id]
        
        # Walk through segments, creating or finding each parent
        current_parent_id: Optional[int] = None
        
        for i, segment in enumerate(segments):
            is_leaf = (i == len(segments) - 1)
            
            # Check if a page with this name already exists at this level
            existing = await self._node_repo.find_page_by_name(segment, current_parent_id)
            row = existing[0] if existing else None
            
            if row:
                # Page exists, use it as parent for next iteration
                current_parent_id = row['id']
            else:
                # Create new page at this level
                page_data = NodeCreateData(
                    name=segment,
                    icon=data.icon if is_leaf else None,  # Only apply icon to leaf
                    color=data.color if is_leaf else None,  # Only apply color to leaf
                    parent_id=current_parent_id,
                    classes=classes,
                    property_values=data.property_values if is_leaf else None,  # Only apply properties to leaf
                )
                
                # Validate and create
                validate_node_create(page_data.name, page_data.icon, page_data.color)
                
                # Validate uniqueness for this segment
                if page_data.classes:
                    await self._validate_page_name_uniqueness(
                        name=page_data.name,
                        parent_id=page_data.parent_id,
                        classes=page_data.classes,
                    )
                
                new_page = await self._node_repo.create(page_data, user_id)
                
                # Parse links and inline classes for the new page
                if new_page.name and new_page.id is not None:
                    await self._link_service.update_node_links(new_page.id, new_page.name)
                    await self._link_service.update_inline_classes(new_page.id, new_page.name)
                
                if is_leaf:
                    # This is the final node to return
                    return new_page
                else:
                    # Use this as parent for next iteration
                    current_parent_id = new_page.id
        
        # Should never reach here, but handle gracefully
        raise RuntimeError("Failed to create hierarchical page")
    
    async def create_node(
        self,
        data: NodeCreateData,
        user_id: Optional[int] = None,
    ) -> Node:
        """Create a new node.
        
        - Validates input fields
        - Validates page name uniqueness per class
        - Computes page_id for blocks
        - Parses content for links and inline classes
        - Applies tag properties (SuperTags)
        - For pages with '/' in name, creates parent hierarchy automatically
        """
        # Strip trailing spaces from name
        if data.name is not None:
            data.name = data.name.rstrip()
        
        # Compute flags from classes to determine if this is a page
        flags = await self._compute_flags_from_classes(data.classes)
        is_page = flags.get('is_page', False)
        
        # Disable hierarchical creation for date pages
        is_date_page = flags.get('is_day', False) or flags.get('is_month', False) or flags.get('is_year', False)
        
        # Handle hierarchical page creation (name contains '/') - but not for date pages
        if is_page and data.name and '/' in data.name and not data.parent_id and not is_date_page:
            return await self._create_hierarchical_page(data, user_id)
        
        # Validate input
        validate_node_create(data.name, data.icon, data.color)
        
        # Validate page name uniqueness if it's a page with classes
        if is_page and data.classes:
            await self._validate_page_name_uniqueness(
                name=data.name,
                parent_id=data.parent_id,
                classes=data.classes,
            )
        
        # Create the node
        if self._user_id:
            await self.permissions.require_workspace_create(self._workspace_id)
        node = await self._node_repo.create(data, user_id)
        
        # Parse and store links and inline classes from content
        if node.name and node.id is not None:
            await self._link_service.update_node_links(node.id, node.name)
            await self._link_service.update_inline_classes(node.id, node.name)
        
        # Re-fetch to get updated version after side effects
        if node.id is not None:
            refreshed = await self._node_repo.get_by_id(node.id)
            if refreshed:
                node = refreshed
        
        # Apply Class properties if any classes have associated properties with defaults
        if node.id is not None and data.classes:
            from ..entities.property import PropertyType, SCALAR_TYPES, RELATION_TYPES

            # Gather all class-property associations for all classes at once,
            # then deduplicate property fetches so each unique property is
            # fetched at most once even when shared across multiple classes.
            all_cp_list = []
            for class_id in data.classes:
                class_properties = await self._property_repo.get_class_properties(class_id)
                all_cp_list.extend(class_properties)

            # Build a cache of property objects keyed by property_id
            prop_cache: Dict[int, Any] = {}
            for cp in all_cp_list:
                if cp.property_id not in prop_cache:
                    prop = await self._property_repo.get_by_id(cp.property_id)
                    prop_cache[cp.property_id] = prop

            for cp in all_cp_list:
                # Get the property to determine its type
                prop = prop_cache.get(cp.property_id)
                if not prop:
                    continue
                
                # Skip if already has a value from property_values
                if data.property_values and cp.property_id in data.property_values:
                    continue
                
                # Set default value based on property type
                try:
                    if prop.type in SCALAR_TYPES:
                        # Integer, Float, Boolean
                        default = None
                        if prop.type == PropertyType.INTEGER and cp.default_integer is not None:
                            default = cp.default_integer
                        elif prop.type == PropertyType.FLOAT and cp.default_float is not None:
                            default = cp.default_float
                        elif prop.type == PropertyType.BOOLEAN and cp.default_boolean is not None:
                            default = cp.default_boolean
                        
                        if default is not None:
                            await self._property_repo.set_scalar_value(node.id, cp.property_id, default)
                    
                    elif prop.type in RELATION_TYPES:
                        # Node, Text, Image, Date
                        default = None
                        if prop.type == PropertyType.NODE and cp.default_node_id is not None:
                            default = cp.default_node_id
                        elif prop.type == PropertyType.TEXT and cp.default_text is not None:
                            default = cp.default_text
                        # Image and Date don't have simple defaults
                        
                        if default is not None:
                            if prop.type == PropertyType.NODE:
                                await self._property_repo.set_relation_value(node.id, cp.property_id, default)
                            else:
                                # For TEXT, IMAGE - create a text node with the default value
                                text_node = await self._node_repo.create(
                                    NodeCreateData(name=serialize_ast(parse_ast(str(default), ParseMode.PLAIN)), parent_id=node.id),
                                    user_id
                                )
                                await self._property_repo.set_relation_value(node.id, cp.property_id, text_node.id)
                    
                    elif prop.type == PropertyType.SELECTION and cp.default_selection_id is not None:
                        await self._property_repo.set_selection_value(node.id, cp.property_id, cp.default_selection_id)
                
                except Exception as e:
                    # Log but don't fail node creation if default value setting fails
                    logger.warning(f"Failed to set default value for property {cp.property_id} on node {node.id}: {e}")
        
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
        Prevents circular references by checking if new_parent is a descendant.
        Enforces maximum hierarchy depth to prevent pathological trees.
        """
        # Get the node before move to check if parent changed
        old_node = await self._node_repo.get_by_id(node_id)
        if not old_node:
            return None
        
        old_parent_id = old_node.parent_id
        
        # Prevent moving parent-locked nodes
        if old_node.parent_locked:
            raise ValueError("Cannot move a parent-locked node")
        
        # Check for circular reference: prevent moving node to its own descendant
        if new_parent_id is not None:
            await self._check_circular_reference(node_id, new_parent_id)
            
            # Check that move won't exceed maximum depth
            await self._check_max_depth(node_id, new_parent_id)
        
        if self._user_id:
            await self.permissions.require_node_write(node_id)
        # Use dedicated move method for proper resequencing
        node = await self._node_repo.move(node_id, new_parent_id, new_sequence, user_id)
        if not node:
            return None
        
        # Update classes path if parent changed (inherited classes may have changed)
        if new_parent_id != old_parent_id and node.id is not None:
            await self._link_service.update_classes_path(node.id)
        
        return node
    
    async def _check_circular_reference(self, node_id: int, new_parent_id: int) -> None:
        """Check if new_parent_id would create a circular reference.
        
        A circular reference occurs if we try to move a node to be a child
        of one of its own descendants.
        
        Args:
            node_id: The node being moved
            new_parent_id: The proposed new parent
            
        Raises:
            ValueError: If the move would create a circular reference
        """
        if node_id == new_parent_id:
            raise ValueError("Cannot move a node to be its own parent")
        
        # Use closure table (node_path) to check if new_parent is a descendant of node
        if await self._node_repo.has_circular_reference(node_id, new_parent_id):
            raise ValueError(
                f"Cannot move node {node_id} to parent {new_parent_id}: "
                f"would create circular reference (parent is a descendant)"
            )
    
    async def _check_max_depth(self, node_id: int, new_parent_id: int) -> None:
        """Check if moving node would exceed maximum hierarchy depth.
        
        Args:
            node_id: The node being moved
            new_parent_id: The proposed new parent
            
        Raises:
            ValueError: If the move would exceed MAX_HIERARCHY_DEPTH
        """
        parent_depth, _ = await self._node_repo.get_depth_info(new_parent_id)
        _, subtree_depth = await self._node_repo.get_depth_info(node_id)
        
        # New depth would be: parent_depth + 1 (for the move) + subtree_depth
        new_max_depth = parent_depth + 1 + subtree_depth
        
        if new_max_depth > MAX_HIERARCHY_DEPTH:
            raise ValueError(
                f"Cannot move node: would exceed maximum hierarchy depth of {MAX_HIERARCHY_DEPTH} "
                f"(resulting depth would be {new_max_depth})"
            )
    
    async def update_node(
        self,
        node_id: int,
        data: NodeUpdateData,
        user_id: Optional[int] = None,
        expected_version: Optional[int] = None,
    ) -> Optional[Node]:
        """Update an existing node.
        
        Validates input fields.
        Validates page name uniqueness if name or classes change.
        If name changes, re-parses links.
        If parent_id changes, updates classes path (inherited classes may change).
        
        Args:
            node_id: ID of node to update
            data: Update data
            user_id: User performing the update
            expected_version: For optimistic locking - update only if version matches
        """
        # Strip trailing spaces from name
        if data.name is not None:
            data.name = data.name.rstrip()
        
        # Validate input
        validate_node_update(data.name, data.icon, data.color)
        
        # Get the node before update
        old_node = await self._node_repo.get_by_id(node_id)
        if not old_node:
            return None
        
        old_parent_id = old_node.parent_id
        
        # Prevent changing parent of parent-locked nodes
        if (data.parent_id is not None or data.clear_parent) and old_node.parent_locked:
            raise ValueError("Cannot change the parent of a parent-locked node")
        
        # Validate page name uniqueness if it's a page and name/parent/classes changed
        if old_node.is_page and (data.name is not None or data.parent_id is not None):
            # Need to get classes - either from update data or fetch them
            check_classes = None
            if data.name is not None or data.parent_id is not None:
                # Get current classes for this node
                check_classes = await self._link_service._link_repo.get_inline_class_targets(node_id)
            
            if check_classes:
                await self._validate_page_name_uniqueness(
                    name=data.name if data.name is not None else old_node.name,
                    parent_id=data.parent_id if data.parent_id is not None else old_parent_id,
                    classes=check_classes,
                    exclude_node_id=node_id,
                )
        
        # Guard against circular references when parent_id changes
        if data.parent_id is not None and data.parent_id != old_parent_id:
            await self._check_circular_reference(node_id, data.parent_id)

        if self._user_id:
            await self.permissions.require_node_write(node_id)
        node = await self._node_repo.update(node_id, data, user_id, expected_version=expected_version)
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
    
    async def delete_node(self, node_id: int, user_id: Optional[int] = None) -> bool:
        """Soft-delete a node and all its children by setting is_deleted=true.
        
        Before soft-deleting, updates all nodes that link to this node:
        - [[nodeId]] links are replaced with the node's name
        - {{nodeId}} inline class references are replaced with the node's name
        - Property class/tag references are removed
        
        If the node is an asset, also deletes the associated asset folder.
        
        Works for both active and archived nodes.
        
        Raises:
            DatePageDeletionError: If trying to delete a month/year page that has active day children
        """
        if self._user_id:
            await self.permissions.require_node_delete(node_id)
        # Get node including archived ones (bypassing active=TRUE filter)
        node = await self._node_repo.get_node_by_id_with_workspace(node_id)
        if not node:
            return False
        
        # Prevent deletion of month/year pages that have active day children
        if node.is_month or node.is_year:
            day_count = await self._count_active_day_descendants(node_id)
            if day_count > 0:
                node_class = "month" if node.is_month else "year"
                raise DatePageDeletionError(node_class, day_count)
        
        # Get all backlinks to this node (from [[nodeId]] links)
        backlinks = await self._link_service.get_backlinks(node_id)
        logger.info(f"[DELETE] Node {node_id} ({node.name}) has {len(backlinks)} backlinks")
        
        # Track nodes we've updated to avoid double-processing
        updated_nodes = set()
        
        # Update each source node to remove/replace the link
        for link in backlinks:
            logger.info(f"[DELETE] Processing backlink from source_node_id={link.source_node_id}")
            source_node = await self._node_repo.get_by_id(link.source_node_id)
            if not source_node or not source_node.name:
                logger.warning(f"[DELETE] Source node {link.source_node_id} not found or has no name")
                continue
            
            logger.info(f"[DELETE] Source node content: {source_node.name[:100]!r}")
            
            # Replace the link in the source node's content
            updated_content = await self._remove_link_from_content(
                source_node.name,
                node,
                "page"  # link_type is no longer used but kept for signature compatibility
            )
            
            logger.info(f"[DELETE] Updated content: {updated_content[:100]!r} (changed={updated_content != source_node.name})")
            
            if updated_content != source_node.name:
                # Update without re-parsing links (to avoid infinite recursion)
                await self._node_repo.update(
                    link.source_node_id,
                    NodeUpdateData(name=updated_content)
                )
                updated_nodes.add(link.source_node_id)
                logger.info(f"[DELETE] Updated source node {link.source_node_id}")
        
        # Also handle inline class references ({{nodeId}})
        await self._replace_inline_class_references(node, updated_nodes)
        
        # Remove this node from any class/tag properties
        await self._remove_node_from_class_tag_properties(node_id)
        
        # Soft-delete the node and all its descendants
        from ...utils import utc_now
        now = utc_now()
        uid = user_id or self._user_id
        
        # Get all descendant IDs using closure table
        descendant_ids = await self._node_repo.get_descendants(node_id)
        all_node_ids = [node_id] + descendant_ids
        
        await self._node_repo.soft_delete_nodes(all_node_ids, now, uid)
        logger.info(f"[DELETE] Soft-deleted node {node_id} and {len(descendant_ids)} descendants")
        
        # If this is an asset node, delete the asset folder
        if node.is_asset and node.uuid:
            try:
                from ...domain.services.asset_service import AssetService
                # Get workspace UUID for asset storage
                workspace_uuid = await get_workspace_uuid(self._workspace_id)
                if workspace_uuid:
                    asset_service = AssetService(workspace_uuid)
                    asset_service.delete_asset(node.uuid)
                    logger.info(f"[DELETE] Deleted asset folder for node {node_id} (uuid={node.uuid})")
                else:
                    logger.error(f"[DELETE] Could not get workspace UUID for workspace_id {self._workspace_id}")
            except Exception as e:
                logger.error(f"[DELETE] Failed to delete asset folder for node {node_id}: {e}", exc_info=True)
                # Continue with soft-delete even if asset deletion fails
        
        return True
    
    async def restore_node(self, node_id: int, user_id: Optional[int] = None) -> Optional[Node]:
        """Restore a soft-deleted node and all its descendants.
        
        Args:
            node_id: The node to restore
            user_id: User performing the restoration
            
        Returns:
            The restored node, or None if not found
        """
        from ...utils import utc_now
        now = utc_now()
        uid = user_id or self._user_id
        
        # Get all descendant IDs including the node itself (bypass soft-delete filter)
        descendant_ids = await self._node_repo.get_all_descendants(node_id, include_self=True)
        if not descendant_ids:
            descendant_ids = [node_id]
        
        await self._node_repo.restore_nodes(descendant_ids, now, uid)
        logger.info(f"[RESTORE] Restored node {node_id} and {len(descendant_ids) - 1} descendants")
        return await self._node_repo.get_by_id(node_id)
    
    async def get_deleted_nodes(self) -> List[Node]:
        """Get all soft-deleted nodes (trash) for the current workspace.
        
        Returns:
            List of deleted nodes
        """
        return await self._node_repo.get_deleted_nodes()
    
    async def permanently_delete_node(self, node_id: int) -> bool:
        """Permanently delete a soft-deleted node (hard delete from database).
        
        This is irreversible. Only works on nodes that are already soft-deleted.
        Before hard-deleting, it removes/replaces backlinks in surviving nodes'
        AST content so inline links don't become orphaned.
        
        Args:
            node_id: The node to permanently delete
            
        Returns:
            True if deleted, False if not found or not in trash
        """
        if self._user_id:
            await self.permissions.require_node_delete(node_id)
        
        node = await self._node_repo.get_node_by_id_with_workspace(node_id)
        if not node:
            return False
        
        # Get all backlinks to this node (from [[nodeId]] links)
        backlinks = await self._link_service.get_backlinks(node_id)
        logger.info(f"[PERM_DELETE] Node {node_id} ({node.name}) has {len(backlinks)} backlinks")
        
        updated_nodes = set()
        
        for link in backlinks:
            source_node = await self._node_repo.get_by_id(link.source_node_id)
            if not source_node or not source_node.name:
                continue
            
            updated_content = await self._remove_link_from_content(
                source_node.name,
                node,
                "page",
                preserve_as_broken=True,
            )
            
            if updated_content != source_node.name:
                await self._node_repo.update(
                    link.source_node_id,
                    NodeUpdateData(name=updated_content)
                )
                updated_nodes.add(link.source_node_id)
                logger.info(f"[PERM_DELETE] Updated source node {link.source_node_id}")
        
        # Also handle inline class references ({{nodeId}})
        await self._replace_inline_class_references(node, updated_nodes)
        
        return await self._node_repo.hard_delete(node_id)
    
    async def empty_trash(self) -> int:
        """Permanently delete all soft-deleted nodes (empty trash).
        
        This is irreversible. All nodes in trash will be hard deleted from the database.
        
        Returns:
            Number of nodes deleted
        """
        from app.logging_config import get_logger
        logger = get_logger(__name__)
        
        trashed = await self._node_repo.get_deleted_nodes()
        logger.info(f"[EMPTY_TRASH] Found {len(trashed)} nodes in trash for workspace {self._workspace_id}")
        
        deleted_count = 0
        for node in trashed:
            node_id = node.id
            logger.info(f"[EMPTY_TRASH] Attempting to hard delete node {node_id}")
            try:
                success = await self.permanently_delete_node(node_id)
                logger.info(f"[EMPTY_TRASH] permanently_delete_node({node_id}) returned {success}")
                if success:
                    deleted_count += 1
            except PermissionDeniedError as e:
                # Node may have been deleted as part of a parent cascade
                logger.info(f"[EMPTY_TRASH] Skipping node {node_id}: {e}")
                continue
        
        logger.info(f"[EMPTY_TRASH] Successfully deleted {deleted_count} of {len(trashed)} nodes")
        return deleted_count
    
    async def batch_permanent_delete(
        self,
        ids: List[int],
    ) -> List[dict]:
        """Permanently delete multiple nodes from trash by ID.
        
        Each ID is processed independently — failures on one do not prevent
        the others from being deleted. Only works on nodes already in trash.
        
        Returns a list of dicts: { "success": bool, "error": str|None }
        """
        results: List[dict] = []
        for node_id in ids:
            try:
                success = await self.permanently_delete_node(node_id)
                if success:
                    results.append({"success": True, "error": None})
                else:
                    results.append({"success": False, "error": "Node not found in trash"})
            except Exception as e:
                logger.warning(f"[BATCH_PERMANENT_DELETE] Failed to delete node {node_id}: {e}")
                results.append({"success": False, "error": str(e)})
        return results
    
    async def _replace_inline_class_references(self, node: Node, already_updated: set) -> None:
        """Replace inline class references ({{nodeId}}) with the node's name.
        
        Args:
            node: The node being deleted
            already_updated: Set of node IDs already processed (to avoid double updates)
        """
        # Get all nodes that reference this node as an inline class
        inline_refs = await self._link_service._link_repo.get_inline_class_references(node.id)
        
        for ref in inline_refs:
            if ref.source_id in already_updated:
                # Already updated from backlinks processing
                continue
            
            source_node = await self._node_repo.get_by_id(ref.source_id)
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
                    ref.source_id,
                    NodeUpdateData(name=updated_content)
                )
    
    async def _remove_link_from_content(
        self,
        content: str,
        target_node: Node,
        link_class: str,
        preserve_as_broken: bool = False,
    ) -> str:
        """Remove or replace a link in content with plain text or broken_link.

        For AST JSON content (modern): walks the AST tree and replaces any
        node_link node referencing the target with a plain-text node whose
        text is the link's custom label (if set) or the target node's
        plain-text name. When preserve_as_broken is True, replaces with a
        broken_link node instead so the original UUID is not lost.

        For legacy plain-text content: uses regex replacement.
        """
        import re
        import json as _json

        # ── AST JSON path (modern content) ────────────────────────────────
        try:
            ast = _json.loads(content)
            if isinstance(ast, list) and (not ast or isinstance(ast[0], dict)):
                # Compute the target's plain-text name once (used when no custom label)
                target_text = ''
                if target_node.name:
                    try:
                        target_name_ast = parse_ast(target_node.name)
                        target_text = stringify_ast(
                            target_name_ast,
                            StringifyOptions(mode=StringifyMode.TEXT_ONLY)
                        )
                    except Exception:
                        target_text = ''

                target_uuid = target_node.uuid or ''
                target_id_str = str(target_node.id)

                def _replace_in_nodes(nodes: list) -> tuple:
                    """Return (new_nodes, changed_flag)."""
                    result: list = []
                    changed = False
                    for node_item in nodes:
                        if not isinstance(node_item, dict):
                            result.append(node_item)
                            continue

                        if node_item.get('type') == 'node_link':
                            link_id = str(node_item.get('link_id', ''))
                            node_identifier = link_id.split(':', 1)[0]
                            if node_identifier and (
                                node_identifier == target_uuid
                                or node_identifier == target_id_str
                            ):
                                changed = True
                                label = node_item.get('label')
                                if preserve_as_broken:
                                    broken = {'type': 'broken_link', 'link_id': link_id}
                                    if label:
                                        broken['label'] = label
                                    result.append(broken)
                                else:
                                    replacement_text = label if label else target_text
                                    result.append({'type': 'text', 'text': replacement_text})
                                continue

                        if 'children' in node_item:
                            new_children, child_changed = _replace_in_nodes(node_item['children'])
                            if child_changed:
                                changed = True
                                node_item = {**node_item, 'children': new_children}

                        result.append(node_item)
                    return result, changed

                new_ast, changed = _replace_in_nodes(ast)
                if changed:
                    return _json.dumps(new_ast)
                return content
        except (_json.JSONDecodeError, TypeError):
            pass

        # ── Legacy plain-text / regex path ────────────────────────────────
        result = content
        link_pattern = re.compile(r'\[\[' + str(target_node.id) + r'\]\]')
        result = link_pattern.sub(target_node.name or '', result)
        class_pattern = re.compile(r'\{\{' + str(target_node.id) + r'\}\}')
        result = class_pattern.sub(target_node.name or '', result)
        return result
    
    async def _remove_node_from_class_tag_properties(self, node_id: int) -> None:
        """Remove a node from any class/tag property values where it's referenced.
        
        When a node used as a class or tag is deleted, remove it from all nodes
        that reference it via property values (especially NODE type properties).
        The inline text references {{nodeId}} are handled separately.
        """
        deleted_count = await self._property_repo.delete_relation_values_by_target(node_id)
        if deleted_count > 0:
            logger.info(f"[DELETE] Removed node {node_id} from {deleted_count} property value relations")
    
    async def _count_active_day_descendants(self, node_id: int) -> int:
        """Count active day pages that are descendants of this node.
        
        Used to prevent deletion of month/year pages that have active daily pages.
        
        Args:
            node_id: The ID of the month or year node to check
            
        Returns:
            Number of active day pages that are descendants of this node
        """
        return await self._node_repo.count_active_day_descendants(node_id)

    async def list_templates(self) -> List[Node]:
        """List all template nodes in this workspace."""
        return await self._node_repo.list_templates()

    async def extract_template_variables(self, node_id: int) -> List[str]:
        """Extract {{variable_name}} placeholders from a node and all its descendants."""
        import re

        template_node = await self._node_repo.get_by_id(node_id)
        if not template_node:
            return []
        descendants = await self._node_repo.get_template_descendants(node_id)
        all_names = [template_node.name] + [d.name for d in descendants]

        pattern = re.compile(r'\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}')
        seen: set = set()
        variables: List[str] = []
        for name in all_names:
            if not name:
                continue
            for match in pattern.finditer(name):
                var = match.group(1)
                if var not in seen:
                    seen.add(var)
                    variables.append(var)
        return variables

    async def instantiate_template(
        self,
        template_id: int,
        user_id: int,
        parent_id: Optional[int] = None,
        name: Optional[str] = None,
        variables: Optional[Dict[str, str]] = None,
        as_blocks: bool = False,
        after_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Create a deep copy of a template node tree.

        Rewrites internal link_id references and substitutes {{variable}} placeholders.
        When as_blocks=True the template root is omitted and its direct children
        are placed under parent_id instead.  When after_id is set, existing
        siblings are shifted to make room and the new blocks are sequenced
        starting after the after_id node.
        """
        import re
        import uuid as uuid_module

        # 1. Load the template root
        template_node = await self._node_repo.get_by_id(template_id)
        if not template_node or not template_node.is_template:
            raise ValueError(f"Node {template_id} is not a template")

        # 2. Load all descendants ordered by depth then sequence
        desc_nodes = await self._node_repo.get_template_descendants(template_id)
        logger.info(f"[TEMPLATE] template_id={template_id}, desc_nodes count={len(desc_nodes)}, names={[n.name[:30] if n.name else '' for n in desc_nodes]}")

        # 3. Look up the template class DB id so we can strip it from copies
        template_class_uuid = SYSTEM_CLASS_UUIDS.get("template", "")
        template_class_db_id = await self._node_repo.find_node_id_by_uuid(template_class_uuid)

        # 4. Build old-id → new-uuid mapping for every node in the tree
        all_old_ids = [template_node.id] + [n.id for n in desc_nodes]
        old_id_to_new_uuid: Dict[int, str] = {old_id: str(uuid_module.uuid4()) for old_id in all_old_ids}

        # old string UUID → new string UUID (for content rewriting)
        old_uuid_to_new_uuid: Dict[str, str] = {}
        old_uuid_to_new_uuid[str(template_node.uuid)] = old_id_to_new_uuid[template_node.id]
        for n in desc_nodes:
            old_uuid_to_new_uuid[str(n.uuid)] = old_id_to_new_uuid[n.id]

        def substitute_content(content: str) -> str:
            if not content:
                return content
            result = content
            for old_uuid, new_uuid in old_uuid_to_new_uuid.items():
                # Rewrite link_id values like "oldUUID:someOtherPart" and plain "oldUUID"
                result = result.replace(f'"link_id":"{old_uuid}:', f'"link_id":"{new_uuid}:')
                result = result.replace(f'"link_id":"{old_uuid}"', f'"link_id":"{new_uuid}"')
            if variables:
                for var_name, var_value in variables.items():
                    result = result.replace('{{' + var_name + '}}', var_value)
            return result

        # 5. Strip template class from root's class_ids
        root_classes = [c for c in list(template_node.class_ids or []) if c != template_class_db_id]

        # 6. Create nodes — root first (unless as_blocks), then descendants depth-first
        old_id_to_new_id: Dict[int, int] = {}

        # When as_blocks + after_id, compute a sequence offset so the new
        # top-level children are inserted right after the anchor block.
        seq_offset = 0
        if as_blocks and after_id is not None and parent_id is not None:
            anchor_seq = await self._node_repo.get_node_sequence(after_id)
            if anchor_seq is not None:
                # Count how many direct template children will be inserted
                direct_count = sum(
                    1 for n in desc_nodes
                    if n.parent_id == template_node.id
                )
                # Shift existing siblings that come after the anchor
                await self._node_repo.shift_sequences(parent_id, anchor_seq, direct_count)
                seq_offset = anchor_seq + 1

        if not as_blocks:
            root_name = substitute_content(name or template_node.name or '')
            root_data = NodeCreateData(
                name=root_name,
                icon=template_node.icon,
                color=template_node.color,
                parent_id=parent_id,
                sequence=0,
                classes=root_classes,
                uuid=old_id_to_new_uuid[template_node.id],
            )
            root_node = await self.create_node(root_data, user_id)
            old_id_to_new_id[template_node.id] = root_node.id
        else:
            # Map template root → the provided parent so children chain correctly
            old_id_to_new_id[template_node.id] = parent_id  # type: ignore[assignment]

        for node in desc_nodes:
            old_id = node.id
            old_parent_id = node.parent_id
            new_parent_id = old_id_to_new_id.get(old_parent_id)  # type: ignore[arg-type]
            if new_parent_id is None:
                logger.warning(f"[TEMPLATE] Skipping node {old_id}: parent {old_parent_id} not yet mapped")
                continue

            # For direct children of the template root in as_blocks mode,
            # offset their sequence so they appear after the anchor block.
            seq = node.sequence
            if as_blocks and old_parent_id == template_node.id:
                seq = seq + seq_offset

            node_data = NodeCreateData(
                name=substitute_content(node.name or ''),
                icon=node.icon,
                color=node.color,
                parent_id=new_parent_id,
                sequence=seq,
                classes=list(node.class_ids or []),
                uuid=old_id_to_new_uuid[old_id],
            )
            new_node = await self.create_node(node_data, user_id)
            old_id_to_new_id[old_id] = new_node.id

        # 7. Copy scalar/relation/selection property values from template root to new root
        if not as_blocks and template_node.id in old_id_to_new_id:
            new_root_id = old_id_to_new_id[template_node.id]
            template_props = await self._property_repo.get_all_property_values(template_node.id)
            from ..entities.property import PropertyType, SCALAR_TYPES, RELATION_TYPES
            for prop_id, prop_data in template_props.items():
                prop = prop_data.get('property')
                values = prop_data.get('values', [])
                if not prop or not values:
                    continue
                try:
                    for val in values:
                        if prop.type in SCALAR_TYPES:
                            scalar = (
                                val.value_integer if getattr(val, 'value_integer', None) is not None else
                                val.value_float if getattr(val, 'value_float', None) is not None else
                                val.value_boolean if getattr(val, 'value_boolean', None) is not None else
                                getattr(val, 'value_text', None)
                            )
                            if scalar is not None:
                                await self._property_repo.set_scalar_value(new_root_id, prop_id, scalar)
                        elif prop.type in RELATION_TYPES:
                            target = getattr(val, 'target_id', None)
                            if target is not None:
                                await self._property_repo.set_relation_value(new_root_id, prop_id, target)
                        elif prop.type == PropertyType.SELECTION:
                            sel_id = getattr(val, 'selection_line_id', None)
                            if sel_id is not None:
                                await self._property_repo.set_selection_value(new_root_id, prop_id, sel_id)
                except Exception as exc:
                    logger.warning(f"[TEMPLATE] Could not copy property {prop_id}: {exc}")

        # 8. Return result
        if as_blocks:
            block_nodes = []
            for node in desc_nodes:
                new_id = old_id_to_new_id.get(node.id)
                if new_id:
                    n = await self._node_repo.get_by_id(new_id)
                    if n:
                        block_nodes.append(n)
            logger.info(f"[TEMPLATE] Returning {len(block_nodes)} blocks (from {len(desc_nodes)} desc_nodes)")
            return {'node': None, 'blocks': block_nodes, 'as_blocks': True}
        else:
            root_node = await self._node_repo.get_by_id(old_id_to_new_id[template_node.id])
            return {'node': root_node, 'blocks': [], 'as_blocks': False}

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
        """Add a class to a node. Delegates to ClassManagementService."""
        return await self._class_service.add_class(
            node_id, class_node_id,
            _system_call=_system_call,
            _page_name_validator=self._validate_page_name_uniqueness,
        )

    async def remove_class(self, node_id: int, class_node_id: int) -> bool:
        """Remove a class from a node. Delegates to ClassManagementService."""
        return await self._class_service.remove_class(node_id, class_node_id)

    async def get_node_classes(self, node_id: int) -> List[Node]:
        """Get all classes applied to a node. Delegates to ClassManagementService."""
        return await self._class_service.get_node_classes(node_id)
    
    async def merge_pages(
        self,
        source_id: int,
        target_id: int,
        user_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Merge source page into target page.

        - Moves all children (blocks) of source to target
        - Redirects content in nodes that link to source so they link to target instead
        - Redirects node_link backlinks from source → target
        - Soft-deletes the source page

        Args:
            source_id: The ID of the page to merge (will be deleted)
            target_id: The ID of the page to merge into
            user_id: User performing the merge

        Returns:
            Dict with children_moved and target_id

        Raises:
            ValueError: If nodes are invalid, same, or not pages
        """
        import re

        source = await self._node_repo.get_by_id(source_id)
        target = await self._node_repo.get_by_id(target_id)

        if not source:
            raise ValueError(f"Source node {source_id} not found")
        if not target:
            raise ValueError(f"Target node {target_id} not found")
        if source_id == target_id:
            raise ValueError("Source and target must be different nodes")
        if source.uuid and target.uuid and source.uuid == target.uuid:
            raise ValueError("Source and target resolve to the same node (UUID match)")
        if not source.is_page:
            raise ValueError("Source node must be a page")
        if not target.is_page:
            raise ValueError("Target node must be a page")
        if source.is_day or source.is_month or source.is_year:
            raise ValueError("Cannot merge date journal pages")

        logger.info(f"[MERGE] Merging node {source_id} ({source.name!r}) into {target_id} ({target.name!r})")

        # Step 1: Get direct children of source
        children = await self._node_repo.get_children(source_id)
        children_ids = [c.id for c in children]

        # Step 2: Determine base sequence offset for appending to target
        base_seq = await self._node_repo.get_max_sequence(target_id) + 1

        # Step 3: Reparent children — the node_path_update DB trigger keeps the closure table in sync
        await self._node_repo.reparent_nodes(children_ids, target_id, target_id, base_seq)

        logger.info(f"[MERGE] Reparented {len(children_ids)} children from {source_id} to {target_id}")

        # Step 4: Update content of nodes that link to source to now link to target.
        # Collect backlink source IDs before redirecting node_link.
        backlink_source_ids = await self._link_service._link_repo.get_backlink_source_ids(source_id)
        backlink_source_ids = [sid for sid in backlink_source_ids if sid != target_id]

        if source.uuid and target.uuid:
            for bsid in backlink_source_ids:
                source_node = await self._node_repo.get_by_id(bsid)
                if not source_node or not source_node.name:
                    continue
                updated = self._redirect_link_in_content(
                    source_node.name,
                    source_id, source.uuid,
                    target_id, target.uuid,
                )
                if updated != source_node.name:
                    await self._node_repo.update(bsid, NodeUpdateData(name=updated))

        # Step 5: Redirect structural backlinks in node_link table
        await self._link_service._link_repo.redirect_link_targets(source_id, target_id)
        logger.info(f"[MERGE] Redirected node_link backlinks from {source_id} to {target_id}")

        # Step 5b: Redirect node-type property values that point to the source page
        pvr_count = await self._node_repo.redirect_property_relation_targets(source_id, target_id)
        logger.info(f"[MERGE] Redirected {pvr_count} property_value_relation rows from {source_id} to {target_id}")

        # Step 5c: Delete outgoing node_links from source page itself.
        await self._link_service._link_repo.delete_source_links(source_id)
        logger.info(f"[MERGE] Deleted outgoing node_links from source page {source_id}")

        # Step 6: Soft-delete source (backlinks already redirected, children already moved)
        await self.delete_node(source_id, user_id)
        logger.info(f"[MERGE] Soft-deleted source node {source_id}")

        return {"children_moved": len(children_ids), "target_id": target_id}

    def _redirect_link_in_content(
        self,
        content: str,
        source_id: int,
        source_uuid: str,
        target_id: int,
        target_uuid: str,
    ) -> str:
        """Replace references to source node with target node in content.

        Handles both the new JSON AST format (link_id field) and the legacy
        [[nodeId]] / {{nodeId}} text formats.
        """
        import re

        result = content

        # JSON AST format: "link_id":"<sourceUuid>:<linkUuid>" or "link_id":"<sourceUuid>"
        result = result.replace(
            f'"link_id":"{source_uuid}:',
            f'"link_id":"{target_uuid}:',
        )
        result = result.replace(
            f'"link_id":"{source_uuid}"',
            f'"link_id":"{target_uuid}"',
        )

        # Legacy [[nodeId]] format
        result = re.sub(
            r'\[\[' + str(source_id) + r'\]\]',
            f'[[{target_id}]]',
            result,
        )

        # Legacy {{nodeId}} inline-class format
        result = re.sub(
            r'\{\{' + str(source_id) + r'\}\}',
            '{{' + str(target_id) + '}}',
            result,
        )

        return result

    async def archive_node(self, node_id: int, user_id: Optional[int] = None) -> Optional[Node]:
        """Archive a node and all its descendants (set active to false)."""
        from ...utils import utc_now
        now = utc_now()
        uid = user_id or self._user_id
        
        descendant_ids = await self._node_repo.get_descendants(node_id)
        all_node_ids = [node_id] + descendant_ids
        
        await self._node_repo.archive_nodes(all_node_ids, now, uid)
        logger.info(f"[ARCHIVE] Archived node {node_id} and {len(descendant_ids)} descendants")
        return await self._node_repo.get_by_id(node_id)

    async def unarchive_node(self, node_id: int, user_id: Optional[int] = None) -> Optional[Node]:
        """Unarchive a node and all its descendants (set active to true)."""
        from ...utils import utc_now
        now = utc_now()
        uid = user_id or self._user_id
        
        descendant_ids = await self._node_repo.get_descendants(node_id)
        all_node_ids = [node_id] + descendant_ids
        
        await self._node_repo.unarchive_nodes(all_node_ids, now, uid)
        logger.info(f"[UNARCHIVE] Unarchived node {node_id} and {len(descendant_ids)} descendants")
        return await self._node_repo.get_by_id(node_id)

    async def get_archived_pages(self) -> List[Node]:
        """Get all archived pages."""
        return await self._node_repo.get_archived_pages()

    # ==================== Batch Operations ====================

    async def batch_create_nodes(
        self,
        items: List[NodeCreateData],
        user_id: Optional[int] = None,
        uuid_conflict_mode: str = "block",
    ) -> List[dict]:
        """Create multiple nodes in a single batch.
        
        Each item is processed independently — failures on one item do not
        prevent the others from being created.  Results are returned in the
        same order as the input list.
        
        uuid_conflict_mode controls what happens when a node with the given UUID
        already exists:
          - 'block' (default): treat as an error (current behaviour).
          - 'return_existing': return the existing node instead of creating a
            new one.  Useful for import flows where the caller will merge content
            at a higher level.
        
        Returns a list of dicts: { "success": bool, "node": Node|None, "error": str|None,
                                   "existing": bool }
        """
        results: List[dict] = []
        for item in items:
            try:
                node = await self.create_node(item, user_id=user_id)
                results.append({"success": True, "node": node, "error": None, "existing": False})
            except Exception as e:
                # When uuid_conflict_mode is 'return_existing', look up the
                # existing node by UUID instead of failing.
                if uuid_conflict_mode == "return_existing" and item.uuid:
                    existing = await self._node_repo.get_by_uuid(item.uuid)
                    if existing:
                        results.append({"success": True, "node": existing, "error": None, "existing": True})
                        continue
                logger.warning(f"[BATCH_CREATE] Failed to create node: {e}")
                results.append({"success": False, "node": None, "error": str(e), "existing": False})
        return results

    async def batch_delete_nodes(
        self,
        uuids: List[str],
        user_id: Optional[int] = None,
    ) -> List[dict]:
        """Delete multiple nodes by UUID in a single batch.
        
        Each UUID is resolved and deleted independently — failures on one
        do not prevent the others from being deleted.
        
        Returns a list of dicts: { "success": bool, "error": str|None }
        """
        results: List[dict] = []
        for uuid in uuids:
            try:
                node = await self._node_repo.get_by_uuid(uuid)
                if not node or node.id is None:
                    results.append({"success": False, "error": f"Node with uuid '{uuid}' not found"})
                    continue
                success = await self.delete_node(node.id, user_id=user_id)
                if success:
                    results.append({"success": True, "error": None})
                else:
                    results.append({"success": False, "error": "Delete returned false"})
            except DatePageDeletionError as e:
                results.append({"success": False, "error": e.message})
            except Exception as e:
                logger.warning(f"[BATCH_DELETE] Failed to delete node {uuid}: {e}")
                results.append({"success": False, "error": str(e)})
        return results

    async def batch_update_nodes(
        self,
        items: List[dict],
        user_id: Optional[int] = None,
    ) -> List[dict]:
        """Update multiple nodes in a single batch.
        
        Each item dict must have 'node_id' (int) and 'data' (NodeUpdateData),
        plus an optional 'expected_version' (int|None).
        
        Failures on one item do not prevent the others from being updated.
        Results are returned in the same order as the input list.
        
        Returns a list of dicts: { "success": bool, "node": Node|None, "error": str|None }
        """
        results: List[dict] = []
        for item in items:
            try:
                node = await self.update_node(
                    item["node_id"],
                    item["data"],
                    user_id=user_id,
                    expected_version=item.get("expected_version"),
                )
                if not node:
                    results.append({"success": False, "node": None, "error": "Node not found"})
                else:
                    results.append({"success": True, "node": node, "error": None})
            except Exception as e:
                logger.warning(f"[BATCH_UPDATE] Failed to update node {item.get('node_id')}: {e}")
                results.append({"success": False, "node": None, "error": str(e)})
        return results
