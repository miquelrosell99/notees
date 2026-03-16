"""Node domain service.

Orchestrates node operations with link parsing and property management.
"""
from __future__ import annotations

from typing import Optional, List, Dict, Any, TYPE_CHECKING

from ..entities import Node, NodeCreateData, NodeUpdateData
from ..errors import SystemClassConstraintError, DatePageDeletionError, DuplicateNodeError
from ..validation import validate_node_create, validate_node_update
from ..stringify_ast import parse_ast, serialize_ast, stringify_ast, ParseMode, StringifyMode, StringifyOptions
from ...db.schema.constants import SYSTEM_CLASS_UUIDS
from ...db.connection import acquire_connection, get_workspace_uuid
from ...logging_config import get_logger

if TYPE_CHECKING:
    from ..repositories import NodeRepository, PropertyRepository, LinkRepository
    from .link_service import LinkParsingService

logger = get_logger(__name__)


# Maximum allowed hierarchy depth to prevent pathological trees
MAX_HIERARCHY_DEPTH = 100


# Date-related classes that are automatically assigned by the system (cannot be manually added/removed)
PROTECTED_DATE_CLASS_UUIDS = {
    SYSTEM_CLASS_UUIDS["year"],
    SYSTEM_CLASS_UUIDS["month"],
    SYSTEM_CLASS_UUIDS["day"],
}

# Block-only classes that cannot be assigned to pages
BLOCK_ONLY_CLASS_UUIDS = {
    SYSTEM_CLASS_UUIDS["query"],
    SYSTEM_CLASS_UUIDS["comment"],
    SYSTEM_CLASS_UUIDS["quote"],
}

# Set of all system class UUIDs for quick lookup
ALL_SYSTEM_CLASS_UUIDS = set(SYSTEM_CLASS_UUIDS.values())

# The 'class' class UUID - nodes with this UUID cannot have 'class' removed from them
CLASS_CLASS_UUID = SYSTEM_CLASS_UUIDS["class"]

# Mapping from class UUID to the node flag field name
CLASS_UUID_TO_FLAG = {
    SYSTEM_CLASS_UUIDS["class"]: "is_class",
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
    
    # Optional attributes set by routers for direct pool/workspace access
    _pool: Any = None
    _workspace_id: Optional[int] = None
    _user_id: Optional[int] = None
    
    def __init__(
        self,
        node_repository: NodeRepository,
        property_repository: PropertyRepository,
        link_service: LinkParsingService,
        page_class_id: int,
        pool: asyncpg.Pool = None,
        workspace_id: int = None,
    ):
        self._node_repo = node_repository
        self._property_repo = property_repository
        self._link_service = link_service
        self._page_class_id = page_class_id
        self._pool = pool
        self._workspace_id = workspace_id
    
    async def _compute_flags_from_classes(self, class_ids: List[int]) -> Dict[str, bool]:
        """Compute is_* flags based on the classes assigned to a node.
        
        Returns a dict with flag names as keys and boolean values.
        Only includes flags for system classes that have corresponding flags.
        """
        flags = {}
        
        if class_ids:
            class_nodes = await self._node_repo.get_by_ids(class_ids)
            for class_node in class_nodes:
                if class_node.uuid in CLASS_UUID_TO_FLAG:
                    flag_name = CLASS_UUID_TO_FLAG[class_node.uuid]
                    flags[flag_name] = True
        
        return flags
    
    async def _update_flags_from_classes(self, node_id: int, class_ids: List[int]) -> None:
        """Update a node's is_* flags based on its current classes.
        
        This ensures flags are always in sync with the assigned classes.
        """
        # Compute all flags from the current classes
        flags_to_set = await self._compute_flags_from_classes(class_ids)
        
        # Create update data with the computed flags
        # We use the classes field to trigger flag recomputation in the repository
        update_data = NodeUpdateData(classes=class_ids)
        await self._node_repo.update(node_id, update_data)
    
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
        
        # Query all pages with same name and parent in this workspace
        pool = self._node_repo.get_connection()
        query = """
            SELECT n.id, n.name, nl.target_id as class_id, class_node.name as class_name
            FROM node n
            LEFT JOIN node_link nl ON nl.source_id = n.id AND nl.is_inline_class = TRUE
            LEFT JOIN node class_node ON class_node.id = nl.target_id
            WHERE n.workspace_id = $1 
                AND n.name = $2 
                AND n.is_page = TRUE 
                AND n.active = TRUE
                AND ($3::INTEGER IS NULL AND n.parent_id IS NULL OR n.parent_id = $3)
        """
        params = [self._workspace_id, name, parent_id]
        
        if exclude_node_id:
            query += " AND n.id != $4"
            params.append(exclude_node_id)
        
        rows = await pool.fetch(query, *params)
        
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
            pool = self._node_repo.get_connection()
            query = """
                SELECT n.id
                FROM node n
                WHERE n.workspace_id = $1 
                    AND n.name = $2 
                    AND n.is_page = TRUE 
                    AND n.active = TRUE
                    AND ($3::INTEGER IS NULL AND n.parent_id IS NULL OR n.parent_id = $3)
                LIMIT 1
            """
            row = await pool.fetchrow(query, self._workspace_id, segment, current_parent_id)
            
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
        node = await self._node_repo.create(data, user_id)
        
        # Parse and store links and inline classes from content
        if node.name and node.id is not None:
            await self._link_service.update_node_links(node.id, node.name)
            await self._link_service.update_inline_classes(node.id, node.name)
        
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
        
        # Check for circular reference: prevent moving node to its own descendant
        if new_parent_id is not None:
            await self._check_circular_reference(node_id, new_parent_id)
            
            # Check that move won't exceed maximum depth
            await self._check_max_depth(node_id, new_parent_id)
        
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
        pool = self._node_repo.get_connection()
        row = await pool.fetchrow("""
            SELECT 1 FROM node_path 
            WHERE ancestor_id = $1 AND descendant_id = $2
        """, node_id, new_parent_id)
        
        if row:
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
        pool = self._node_repo.get_connection()
        
        # Get depth of new parent (how deep is new_parent from root)
        parent_depth_row = await pool.fetchrow("""
            SELECT COALESCE(MAX(depth), 0) as parent_depth
            FROM node_path
            WHERE descendant_id = $1
        """, new_parent_id)
        parent_depth = parent_depth_row['parent_depth'] if parent_depth_row else 0
        
        # Get max depth of subtree being moved (how deep is node's deepest descendant)
        subtree_depth_row = await pool.fetchrow("""
            SELECT COALESCE(MAX(depth), 0) as subtree_depth
            FROM node_path
            WHERE ancestor_id = $1
        """, node_id)
        subtree_depth = subtree_depth_row['subtree_depth'] if subtree_depth_row else 0
        
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
        
        # Validate page name uniqueness if it's a page and name/parent/classes changed
        if old_node.is_page and (data.name is not None or data.parent_id is not None):
            # Need to get classes - either from update data or fetch them
            check_classes = None
            if data.name is not None or data.parent_id is not None:
                # Get current classes for this node
                pool = self._node_repo.get_connection()
                class_rows = await pool.fetch(
                    "SELECT target_id as class_id FROM node_link WHERE source_id = $1 AND is_inline_class = TRUE ORDER BY position",
                    node_id
                )
                check_classes = [row['class_id'] for row in class_rows]
            
            if check_classes:
                await self._validate_page_name_uniqueness(
                    name=data.name if data.name is not None else old_node.name,
                    parent_id=data.parent_id if data.parent_id is not None else old_parent_id,
                    classes=check_classes,
                    exclude_node_id=node_id,
                )
        
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
        # Get node including archived ones (bypassing active=TRUE filter)
        pool = self._node_repo.get_connection()
        row = await pool.fetchrow(
            "SELECT * FROM node WHERE id = $1 AND workspace_id = $2",
            node_id, self._workspace_id
        )
        if not row:
            return False
        
        node = self._node_repo.row_to_node(row)
        
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
        
        async with acquire_connection(pool) as conn:
            async with conn.transaction():
                # Get all descendants using closure table
                descendant_rows = await conn.fetch("""
                    SELECT descendant_id FROM node_path 
                    WHERE ancestor_id = $1 AND depth > 0
                """, node_id)
                
                descendant_ids = [row['descendant_id'] for row in descendant_rows]
                all_node_ids = [node_id] + descendant_ids
                
                # Soft-delete all nodes (parent and descendants)
                await conn.execute("""
                    UPDATE node 
                    SET is_deleted = TRUE, deleted_at = $1, write_date = $1, write_uid = $2
                    WHERE id = ANY($3::integer[]) AND workspace_id = $4
                """, now, uid, all_node_ids, self._workspace_id)
                
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
        """Restore a soft-deleted node (and optionally its descendants).
        
        Args:
            node_id: The node to restore
            user_id: User performing the restoration
            
        Returns:
            The restored node, or None if not found
        """
        from ...utils import utc_now
        now = utc_now()
        uid = user_id or self._user_id
        
        pool = self._node_repo.get_connection()
        async with acquire_connection(pool) as conn:
            async with conn.transaction():
                # Check if node exists and is deleted
                row = await conn.fetchrow("""
                    SELECT * FROM node 
                    WHERE id = $1 AND workspace_id = $2 AND is_deleted = TRUE
                """, node_id, self._workspace_id)
                
                if not row:
                    return None
                
                # Restore the node
                await conn.execute("""
                    UPDATE node 
                    SET is_deleted = FALSE, deleted_at = NULL, write_date = $1, write_uid = $2
                    WHERE id = $3 AND workspace_id = $4
                """, now, uid, node_id, self._workspace_id)
                
                logger.info(f"[RESTORE] Restored node {node_id}")
        
        return await self._node_repo.get_by_id(node_id)
    
    async def get_deleted_nodes(self) -> List[Node]:
        """Get all soft-deleted nodes (trash) for the current workspace.
        
        Returns:
            List of deleted nodes
        """
        pool = self._node_repo.get_connection()
        rows = await pool.fetch("""
            SELECT * FROM node 
            WHERE workspace_id = $1 AND is_deleted = true
            ORDER BY deleted_at DESC NULLS LAST
        """, self._workspace_id)
        
        return [self._node_repo.row_to_node(row) for row in rows]
    
    async def permanently_delete_node(self, node_id: int) -> bool:
        """Permanently delete a soft-deleted node (hard delete from database).
        
        This is irreversible. Only works on nodes that are already soft-deleted.
        
        Args:
            node_id: The node to permanently delete
            
        Returns:
            True if deleted, False if not found or not in trash
        """
        pool = self._node_repo.get_connection()
        row = await pool.fetchrow("""
            SELECT * FROM node 
            WHERE id = $1 AND workspace_id = $2 AND is_deleted = true
        """, node_id, self._workspace_id)
        
        if not row:
            return False
        
        # Use the repository's hard_delete method to permanently remove from database
        return await self._node_repo.hard_delete(node_id)
    
    async def empty_trash(self) -> int:
        """Permanently delete all soft-deleted nodes (empty trash).
        
        This is irreversible. All nodes in trash will be hard deleted from the database.
        
        Returns:
            Number of nodes deleted
        """
        from app.logging_config import get_logger
        logger = get_logger(__name__)
        
        pool = self._node_repo.get_connection()
        rows = await pool.fetch("""
            SELECT id FROM node 
            WHERE workspace_id = $1 AND is_deleted = true
        """, self._workspace_id)
        
        logger.info(f"[EMPTY_TRASH] Found {len(rows)} nodes in trash for workspace {self._workspace_id}")
        
        deleted_count = 0
        for row in rows:
            node_id = row['id']
            # Check if node still exists (it may have been deleted as a descendant of another node)
            exists = await pool.fetchrow("SELECT id FROM node WHERE id = $1 AND workspace_id = $2", node_id, self._workspace_id)
            if not exists:
                logger.info(f"[EMPTY_TRASH] Node {node_id} already deleted (was descendant of another trash node)")
                continue
            
            logger.info(f"[EMPTY_TRASH] Attempting to hard delete node {node_id}")
            try:
                success = await self._node_repo.hard_delete(node_id)
                logger.info(f"[EMPTY_TRASH] hard_delete({node_id}) returned {success}")
                if success:
                    deleted_count += 1
            except PermissionError as e:
                # Node may have been deleted as part of a parent cascade
                logger.info(f"[EMPTY_TRASH] Skipping node {node_id}: {e}")
                continue
        
        logger.info(f"[EMPTY_TRASH] Successfully deleted {deleted_count} of {len(rows)} nodes")
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
        link_class: str
    ) -> str:
        """Remove or replace a link in content with plain text.

        For AST JSON content (modern): walks the AST tree and replaces any
        node_link node referencing the target with a plain-text node whose
        text is the link's custom label (if set) or the target node's
        plain-text name.

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
        if self._pool is None:
            return
        
        async with acquire_connection(self._pool) as conn:
            # Remove from property_value_relation where this node is the target
            # This handles NODE-type properties that reference this node
            result = await conn.execute("""
                DELETE FROM property_value_relation 
                WHERE target_id = $1
            """, node_id)
            
            # Extract the number of deleted rows from the result string (e.g., "DELETE 3")
            deleted_count = int(result.split()[-1]) if result and result.split()[-1].isdigit() else 0
            
            if deleted_count > 0:
                logger.info(f"[DELETE] Removed node {node_id} from {deleted_count} property value relations")
            
            # Note: Scalar and selection values don't reference other nodes directly,
            # so no cleanup needed for those tables. The ON DELETE CASCADE in the schema
            # will handle cleanup when the node itself is deleted.
    
    async def _count_active_day_descendants(self, node_id: int) -> int:
        """Count active day pages that are descendants of this node.
        
        Used to prevent deletion of month/year pages that have active daily pages.
        
        Args:
            node_id: The ID of the month or year node to check
            
        Returns:
            Number of active day pages that are descendants of this node
        """
        if self._pool is None or self._workspace_id is None:
            return 0
        
        async with acquire_connection(self._pool) as conn:
            # Use closure table (node_path) to find all descendants, then count day pages
            row = await conn.fetchrow("""
                SELECT COUNT(*) as day_count 
                FROM node_path np
                JOIN node n ON n.id = np.descendant_id
                WHERE np.ancestor_id = $1 
                  AND np.depth > 0
                  AND n.workspace_id = $2 
                  AND n.active = TRUE
                  AND n.is_day = TRUE
            """, node_id, self._workspace_id)
            
            return row['day_count'] if row else 0

    async def list_templates(self) -> List[Node]:
        """List all template nodes in this workspace."""
        if self._pool is None or self._workspace_id is None:
            return []

        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT * FROM node
                WHERE workspace_id = $1
                  AND is_template = TRUE
                  AND active = TRUE
                  AND (is_deleted = FALSE OR is_deleted IS NULL)
                ORDER BY name
            """, self._workspace_id)
            return [self._node_repo.row_to_node(row) for row in rows]

    async def extract_template_variables(self, node_id: int) -> List[str]:
        """Extract {{variable_name}} placeholders from a node and all its descendants."""
        import re

        if self._pool is None or self._workspace_id is None:
            return []

        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT n.name FROM node n
                WHERE n.id = $1 AND n.workspace_id = $2
                  AND n.active = TRUE
                UNION
                SELECT n.name FROM node_path np
                JOIN node n ON n.id = np.descendant_id
                WHERE np.ancestor_id = $1 AND np.depth > 0
                  AND n.workspace_id = $2 AND n.active = TRUE
            """, node_id, self._workspace_id)

        pattern = re.compile(r'\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}')
        seen: set = set()
        variables: List[str] = []
        for row in rows:
            name = row['name']
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

        if self._pool is None or self._workspace_id is None:
            raise ValueError("Service not fully initialised (missing pool or workspace_id)")

        # 1. Load the template root
        template_node = await self._node_repo.get_by_id(template_id)
        if not template_node or not template_node.is_template:
            raise ValueError(f"Node {template_id} is not a template")

        # 2. Load all descendants ordered by depth then sequence
        async with acquire_connection(self._pool) as conn:
            desc_rows = await conn.fetch("""
                SELECT n.id, n.uuid, n.name, n.icon, n.color,
                       n.parent_id, n.sequence, n.class_ids, n.collapsed
                FROM node_path np
                JOIN node n ON n.id = np.descendant_id
                WHERE np.ancestor_id = $1 AND np.depth > 0
                  AND n.workspace_id = $2
                  AND n.active = TRUE
                  AND (n.is_deleted = FALSE OR n.is_deleted IS NULL)
                ORDER BY np.depth, n.sequence
            """, template_id, self._workspace_id)
            logger.info(f"[TEMPLATE] template_id={template_id}, desc_rows count={len(desc_rows)}, names={[r['name'][:30] if r['name'] else '' for r in desc_rows]}")

            # 3. Look up the template class DB id so we can strip it from copies
            template_class_uuid = SYSTEM_CLASS_UUIDS.get("template", "")
            tc_row = await conn.fetchrow(
                "SELECT id FROM node WHERE uuid::text = $1 AND workspace_id = $2",
                template_class_uuid, self._workspace_id
            )
        template_class_db_id: Optional[int] = tc_row['id'] if tc_row else None

        # 4. Build old-id → new-uuid mapping for every node in the tree
        all_old_ids = [template_node.id] + [int(r['id']) for r in desc_rows]
        old_id_to_new_uuid: Dict[int, str] = {old_id: str(uuid_module.uuid4()) for old_id in all_old_ids}

        # old string UUID → new string UUID (for content rewriting)
        old_uuid_to_new_uuid: Dict[str, str] = {}
        old_uuid_to_new_uuid[str(template_node.uuid)] = old_id_to_new_uuid[template_node.id]
        for r in desc_rows:
            old_uuid_to_new_uuid[str(r['uuid'])] = old_id_to_new_uuid[int(r['id'])]

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
            async with acquire_connection(self._pool) as conn:
                after_row = await conn.fetchrow(
                    "SELECT sequence FROM node WHERE id = $1 AND workspace_id = $2",
                    after_id, self._workspace_id
                )
                if after_row:
                    anchor_seq = after_row['sequence']
                    # Count how many direct template children will be inserted
                    direct_count = sum(
                        1 for r in desc_rows
                        if int(r['parent_id']) == template_node.id
                    )
                    # Shift existing siblings that come after the anchor
                    await conn.execute(
                        """UPDATE node SET sequence = sequence + $1
                           WHERE parent_id = $2 AND sequence > $3
                             AND workspace_id = $4 AND active = TRUE""",
                        direct_count, parent_id, anchor_seq, self._workspace_id
                    )
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

        for row in desc_rows:
            old_id = int(row['id'])
            old_parent_id = int(row['parent_id']) if row['parent_id'] is not None else None
            new_parent_id = old_id_to_new_id.get(old_parent_id)  # type: ignore[arg-type]
            if new_parent_id is None:
                logger.warning(f"[TEMPLATE] Skipping node {old_id}: parent {old_parent_id} not yet mapped")
                continue

            # For direct children of the template root in as_blocks mode,
            # offset their sequence so they appear after the anchor block.
            seq = row['sequence']
            if as_blocks and old_parent_id == template_node.id:
                seq = seq + seq_offset

            node_data = NodeCreateData(
                name=substitute_content(row['name'] or ''),
                icon=row['icon'],
                color=row['color'],
                parent_id=new_parent_id,
                sequence=seq,
                classes=list(row['class_ids'] or []),
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
            for row in desc_rows:
                new_id = old_id_to_new_id.get(int(row['id']))
                if new_id:
                    n = await self._node_repo.get_by_id(new_id)
                    if n:
                        block_nodes.append(n)
            logger.info(f"[TEMPLATE] Returning {len(block_nodes)} blocks (from {len(desc_rows)} desc_rows)")
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
        """Add a class to a node using direct class_ids array.
        
        Validates page name uniqueness if this is a page.
        
        Args:
            node_id: The node to add the class to
            class_node_id: The class node ID to add
            _system_call: Internal flag - if True, bypasses date class protection (for system endpoints)
        
        Raises:
            SystemClassConstraintError: If trying to add a protected date class (day, month, year)
            DuplicateNodeError: If adding this class would violate page name uniqueness
        """
        # Check if the class being added is a protected date class
        class_node = await self._node_repo.get_by_id(class_node_id)
        if class_node and class_node.uuid in PROTECTED_DATE_CLASS_UUIDS and not _system_call:
            raise SystemClassConstraintError(
                f"Cannot manually add '{class_node.name}' class. Date classes (day, month, year) are managed by the system."
            )
        
        # Get current node and class_ids
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT id, name, is_page, parent_id, class_ids FROM node WHERE id = $1 AND workspace_id = $2",
                node_id, self._workspace_id
            )
            if not row:
                return False
            
            # Check if trying to add 'class' class to a non-page node
            if class_node and class_node.uuid == CLASS_CLASS_UUID:
                if not row['is_page']:
                    raise SystemClassConstraintError(
                        "The 'class' class can only be assigned to pages, not blocks."
                    )
            
            # Check if trying to add block-only classes to a page
            if class_node and class_node.uuid in BLOCK_ONLY_CLASS_UUIDS:
                if row['is_page']:
                    raise SystemClassConstraintError(
                        f"The '{class_node.name}' class can only be assigned to blocks, not pages."
                    )
            
            current_class_ids = list(row['class_ids'] or [])
            if class_node_id in current_class_ids:
                return False  # Already has this class
            
            # Validate page name uniqueness if this is a page
            if row['is_page']:
                new_classes = current_class_ids + [class_node_id]
                await self._validate_page_name_uniqueness(
                    name=row['name'],
                    parent_id=row['parent_id'],
                    classes=new_classes,
                    exclude_node_id=node_id,
                )
            
            # Add the class to class_ids array
            new_class_ids = current_class_ids + [class_node_id]
            await conn.execute(
                "UPDATE node SET class_ids = $1, write_date = NOW(), version = version + 1 WHERE id = $2",
                new_class_ids, node_id
            )
            
            # Recompute all flags from the updated classes list
            await self._update_flags_from_classes(node_id, new_class_ids)
        
        # Apply Class properties with default values
        from ..entities.property import PropertyType, SCALAR_TYPES, RELATION_TYPES
        
        class_properties = await self._property_repo.get_class_properties(class_node_id)
        for cp in class_properties:
            # Get the property to determine its type
            prop = await self._property_repo.get_by_id(cp.property_id)
            if not prop:
                continue
            
            # Check if property already has a value - don't override existing values
            existing_values = await self._property_repo.get_all_property_values(node_id)
            if cp.property_id in existing_values and existing_values[cp.property_id].get('values'):
                continue
            
            # Set default value based on property type
            try:
                if prop.type in SCALAR_TYPES:
                    default = None
                    if prop.type == PropertyType.INTEGER and cp.default_integer is not None:
                        default = cp.default_integer
                    elif prop.type == PropertyType.FLOAT and cp.default_float is not None:
                        default = cp.default_float
                    elif prop.type == PropertyType.BOOLEAN and cp.default_boolean is not None:
                        default = cp.default_boolean
                    
                    if default is not None:
                        await self._property_repo.set_scalar_value(node_id, cp.property_id, default)
                
                elif prop.type in RELATION_TYPES:
                    default = None
                    if prop.type == PropertyType.NODE and cp.default_node_id is not None:
                        default = cp.default_node_id
                    elif prop.type == PropertyType.TEXT and cp.default_text is not None:
                        default = cp.default_text
                    # Image and Date don't have simple defaults
                    
                    if default is not None:
                        if prop.type == PropertyType.NODE:
                            await self._property_repo.set_relation_value(node_id, cp.property_id, default)
                        else:
                            # For TEXT - create a text node with the default value
                            text_node = await self._node_repo.create(
                                NodeCreateData(name=serialize_ast(parse_ast(str(default), ParseMode.PLAIN)), parent_id=node_id),
                                None  # user_id
                            )
                            await self._property_repo.set_relation_value(node_id, cp.property_id, text_node.id)
                
                elif prop.type == PropertyType.SELECTION and cp.default_selection_id is not None:
                    await self._property_repo.set_selection_value(node_id, cp.property_id, cp.default_selection_id)
            
            except Exception as e:
                # Log but don't fail if default value setting fails
                logger.warning(f"Failed to set default value for property {cp.property_id} on node {node_id}: {e}")
        
        return True
    
    async def remove_class(self, node_id: int, class_node_id: int) -> bool:
        """Remove a class from a node using direct class_ids array.
        
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
        
        # Remove class from class_ids array
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT class_ids FROM node WHERE id = $1 AND workspace_id = $2",
                node_id, self._workspace_id
            )
            if not row:
                return False
            
            current_class_ids = list(row['class_ids'] or [])
            if class_node_id not in current_class_ids:
                return False  # Class was not assigned to this node
            
            # Remove the class
            new_class_ids = [cid for cid in current_class_ids if cid != class_node_id]
            await conn.execute(
                "UPDATE node SET class_ids = $1, write_date = NOW(), version = version + 1 WHERE id = $2",
                new_class_ids, node_id
            )
            
            # Recompute all flags from the updated classes list
            await self._update_flags_from_classes(node_id, new_class_ids)
        
        return True
    
    async def get_node_classes(self, node_id: int) -> List[Node]:
        """Get all classes applied to a node from class_ids array."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT class_ids FROM node WHERE id = $1 AND workspace_id = $2",
                node_id, self._workspace_id
            )
            if not row or not row['class_ids']:
                return []
            
            # Fetch all class nodes
            rows = await conn.fetch(
                "SELECT * FROM node WHERE id = ANY($1) AND workspace_id = $2",
                row['class_ids'], self._workspace_id
            )
            return [self._node_repo.row_to_node(r) for r in rows]
    
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

        pool = self._node_repo.get_connection()

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
        children_rows = await pool.fetch(
            "SELECT id FROM node WHERE parent_id = $1 AND active = TRUE ORDER BY sequence",
            source_id,
        )
        children_ids = [row['id'] for row in children_rows]

        # Step 2: Determine base sequence offset for appending to target
        max_seq_row = await pool.fetchrow(
            "SELECT COALESCE(MAX(sequence), -1) as max_seq FROM node WHERE parent_id = $1",
            target_id,
        )
        base_seq = (max_seq_row['max_seq'] if max_seq_row else -1) + 1

        # Step 3: Reparent children — the node_path_update DB trigger keeps the closure table in sync
        for i, child_id in enumerate(children_ids):
            await pool.execute(
                """UPDATE node
                      SET parent_id = $1, page_id = $2, sequence = $3,
                          write_date = NOW(), version = version + 1
                    WHERE id = $4 AND workspace_id = $5""",
                target_id, target_id, base_seq + i, child_id, self._workspace_id,
            )

        logger.info(f"[MERGE] Reparented {len(children_ids)} children from {source_id} to {target_id}")

        # Step 4: Update content of nodes that link to source to now link to target.
        # Collect backlink source IDs before redirecting node_link.
        backlink_rows = await pool.fetch(
            "SELECT DISTINCT source_id FROM node_link WHERE target_id = $1 AND source_id != $2",
            source_id, target_id,
        )
        backlink_source_ids = [row['source_id'] for row in backlink_rows]

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
        await pool.execute(
            "UPDATE node_link SET target_id = $1 WHERE target_id = $2",
            target_id, source_id,
        )
        logger.info(f"[MERGE] Redirected node_link backlinks from {source_id} to {target_id}")

        # Step 5b: Redirect node-type property values that point to the source page
        pvr_result = await pool.execute(
            "UPDATE property_value_relation SET target_id = $1 WHERE target_id = $2",
            target_id, source_id,
        )
        pvr_count = int(pvr_result.split()[-1]) if pvr_result and pvr_result.split()[-1].isdigit() else 0
        logger.info(f"[MERGE] Redirected {pvr_count} property_value_relation rows from {source_id} to {target_id}")

        # Step 5c: Delete outgoing node_links from source page itself.
        # These are links in the source page's own content (source_id = source).
        # Children were already reparented so their links are fine, but the
        # source page's own outgoing links would otherwise remain orphaned
        # after soft-delete, showing up as backlinks from a missing node.
        await pool.execute(
            "DELETE FROM node_link WHERE source_id = $1",
            source_id,
        )
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
        pool = self._node_repo.get_connection()
        now = utc_now()
        uid = user_id or self._user_id
        
        async with acquire_connection(pool) as conn:
            async with conn.transaction():
                # Get all descendants using closure table
                descendant_rows = await conn.fetch("""
                    SELECT descendant_id FROM node_path 
                    WHERE ancestor_id = $1 AND depth > 0
                """, node_id)
                
                descendant_ids = [row['descendant_id'] for row in descendant_rows]
                all_node_ids = [node_id] + descendant_ids
                
                # Archive all nodes (parent and descendants)
                await conn.execute("""
                    UPDATE node 
                    SET active = FALSE, write_date = $1, write_uid = $2, version = version + 1
                    WHERE id = ANY($3::integer[]) AND workspace_id = $4
                """, now, uid, all_node_ids, self._workspace_id)
                
                logger.info(f"[ARCHIVE] Archived node {node_id} and {len(descendant_ids)} descendants")
                
                # Return the archived parent node
                row = await conn.fetchrow(
                    "SELECT * FROM node WHERE id = $1 AND workspace_id = $2",
                    node_id, self._workspace_id
                )
                return self._node_repo.row_to_node(row) if row else None

    async def unarchive_node(self, node_id: int, user_id: Optional[int] = None) -> Optional[Node]:
        """Unarchive a node and all its descendants (set active to true)."""
        from ...utils import utc_now
        pool = self._node_repo.get_connection()
        now = utc_now()
        uid = user_id or self._user_id
        
        async with acquire_connection(pool) as conn:
            async with conn.transaction():
                # Get all descendants using closure table
                descendant_rows = await conn.fetch("""
                    SELECT descendant_id FROM node_path 
                    WHERE ancestor_id = $1 AND depth > 0
                """, node_id)
                
                descendant_ids = [row['descendant_id'] for row in descendant_rows]
                all_node_ids = [node_id] + descendant_ids
                
                # Unarchive all nodes (parent and descendants)
                await conn.execute("""
                    UPDATE node 
                    SET active = TRUE, write_date = $1, write_uid = $2, version = version + 1
                    WHERE id = ANY($3::integer[]) AND workspace_id = $4
                """, now, uid, all_node_ids, self._workspace_id)
                
                logger.info(f"[UNARCHIVE] Unarchived node {node_id} and {len(descendant_ids)} descendants")
                
                # Return the unarchived parent node
                row = await conn.fetchrow(
                    "SELECT * FROM node WHERE id = $1 AND workspace_id = $2",
                    node_id, self._workspace_id
                )
                return self._node_repo.row_to_node(row) if row else None

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
