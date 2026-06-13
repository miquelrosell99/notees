"""Node domain service.

Orchestrates node operations with link parsing and property management.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from ...db.connection import get_workspace_uuid
from ...db.schema.constants import SYSTEM_CLASS_UUIDS
from ...logging_config import get_logger
from ..entities import Node, NodeCreateData, NodeUpdateData
from ..errors import DatePageDeletionError, DuplicateNodeError, NodeValidationError, PermissionDeniedError
from ..permissions import PermissionChecker
from ..stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, serialize_ast, stringify_ast
from ..validation import validate_node_create, validate_node_update
from .class_extension_service import ClassExtensionService
from .class_management_service import ClassManagementService

if TYPE_CHECKING:
    from ..repositories import (
        ActivityRepository,
        ClassExtendRepository,
        NodeRepository,
        PropertyRepository,
        SettingsRepository,
        UserRepository,
    )
    from .link_service import LinkParsingService
    from .mention_service import MentionService

logger = get_logger(__name__)


# Maximum allowed hierarchy depth to prevent pathological trees
MAX_HIERARCHY_DEPTH = 100

# Maximum descendants to load in a single read operation to prevent unbounded reads
MAX_DESCENDANTS_LOAD = 5000


def _format_node_name(raw_name: str | None) -> str:
    """Extract plain text from a node name, handling AST JSON gracefully."""
    if not raw_name:
        return "Unknown"
    try:
        ast = parse_ast(raw_name, ParseMode.JSON)
        text = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
        return text.strip() or "Unknown"
    except (ValueError, TypeError, KeyError):
        return raw_name


class NodeService:
    """Domain service for node operations."""

    def __init__(
        self,
        node_repository: NodeRepository,
        property_repository: PropertyRepository,
        link_service: LinkParsingService,
        page_class_id: int,
        workspace_id: int | None = None,
        user_id: int | None = None,
        settings_repo: SettingsRepository | None = None,
        activity_repo: ActivityRepository | None = None,
        class_extend_repo: ClassExtendRepository | None = None,
        user_repository: UserRepository | None = None,
        mention_service: MentionService | None = None,
    ):
        self._node_repo = node_repository
        self._property_repo = property_repository
        self._link_service = link_service
        self._page_class_id = page_class_id
        self._workspace_id = workspace_id
        self._user_id = user_id
        self._settings_repo = settings_repo
        self._activity_repo = activity_repo
        self._user_repo = user_repository
        self._mention_service = mention_service
        self._class_service = ClassManagementService(
            workspace_id, node_repository, property_repository, class_extend_repo
        )
        self._permissions: PermissionChecker | None = None

    # ── Public properties ──────────────────────────────────────────────────

    @property
    def workspace_id(self) -> int | None:
        """Workspace ID for this service instance."""
        return self._workspace_id

    @property
    def page_class_id(self) -> int | None:
        """Page class node ID."""
        return self._page_class_id

    @property
    def property_repo(self):
        """Property repository (used by property routers that need repo-level CRUD)."""
        return self._property_repo

    @property
    def user_repo(self):
        """User repository (used for mention lookups)."""
        return self._user_repo

    @property
    def permissions(self) -> PermissionChecker:
        if self._permissions is None:
            if self._user_id is None:
                raise RuntimeError("User ID required for permission checks")
            self._permissions = PermissionChecker(self._user_id)
        return self._permissions

    # ── Public delegation methods ──────────────────────────────────────────

    async def get_node_children(self, node_id: int) -> list[Node]:
        """Get direct children of a node."""
        return await self._node_repo.get_children(node_id)

    async def get_node_descendants(self, node_id: int) -> list[Node]:
        """Get descendants of a node, bounded to prevent unbounded reads."""
        descendant_ids = await self._node_repo.get_descendants(node_id, include_self=False)
        if not descendant_ids:
            return []
        if len(descendant_ids) > MAX_DESCENDANTS_LOAD:
            logger.warning(
                "Node %s has %s descendants; clamping load to %s",
                node_id,
                len(descendant_ids),
                MAX_DESCENDANTS_LOAD,
            )
            descendant_ids = descendant_ids[:MAX_DESCENDANTS_LOAD]
        return await self._node_repo.get_by_ids(descendant_ids)

    async def get_node_descendants_batch(
        self, node_ids: list[int]
    ) -> dict[int, list[int]]:
        """Get all descendant IDs for multiple nodes in a single query.

        Returns a mapping of node_id -> list of descendant IDs.
        """
        if hasattr(self._node_repo, "get_descendants_batch"):
            return await self._node_repo.get_descendants_batch(node_ids, include_self=False)
        # Fallback: loop over individual nodes
        result: dict[int, list[int]] = {}
        for node_id in node_ids:
            result[node_id] = await self._node_repo.get_descendants(node_id, include_self=False)
        return result

    async def get_nodes_typed_with(self, class_id: int) -> list[Node]:
        """Get all nodes that have this class assigned."""
        return await self._node_repo.get_typed_with(class_id)

    async def get_nodes_by_ids(self, ids: list[int]) -> list[Node]:
        """Get multiple nodes by ID list."""
        return await self._node_repo.get_by_ids(ids)

    async def get_class_ids_batch(self, node_ids: list[int]) -> dict[int, list[int]]:
        """Get class_ids arrays for multiple nodes in a single query."""
        return await self._node_repo.get_class_ids_batch(node_ids)

    async def get_node_class_ids(self, node_id: int) -> list[int]:
        """Get class_ids array for a single node."""
        return await self._node_repo.get_node_class_ids(node_id)

    async def get_tag_link_targets(self, node_id: int) -> list[int]:
        """Get tag IDs for a source node."""
        return await self._node_repo.get_node_tag_ids(node_id)

    async def get_tag_link_targets_batch(self, node_ids: list[int]) -> dict[int, list[int]]:
        """Get tag IDs for multiple source nodes."""
        return await self._node_repo.get_tag_ids_batch(node_ids)

    async def get_alias_node_ids(self, target_node_id: int) -> list[int]:
        """Get IDs of nodes that alias the target node."""
        return await self._link_service._link_repo.get_alias_node_ids(target_node_id)

    async def get_alias_node_ids_batch(self, target_node_ids: list[int]) -> dict[int, list[int]]:
        """Get alias node IDs for multiple target nodes."""
        return await self._link_service._link_repo.get_alias_node_ids_batch(target_node_ids)

    async def list_unlinked_mentions(self, target_node_id: int) -> list[dict[str, Any]]:
        """List unlinked mention candidates for a target node."""
        if self._mention_service is None:
            return []
        return await self._mention_service.list_unlinked_mentions(target_node_id)

    async def promote_mention(self, mention_id: int) -> Node | None:
        """Promote an unlinked mention into a real node link."""
        if self._mention_service is None:
            return None
        return await self._mention_service.promote_mention(mention_id)

    async def ignore_mention(self, mention_id: int) -> Any | None:
        """Ignore an unlinked mention candidate."""
        if self._mention_service is None:
            return None
        return await self._mention_service.ignore_mention(mention_id)

    async def unignore_mention(self, mention_id: int) -> Any | None:
        """Restore a previously ignored mention candidate."""
        if self._mention_service is None:
            return None
        return await self._mention_service.unignore_mention(mention_id)

    async def get_extended_classes_batch(self, node_ids: list[int]) -> dict[int, list[int]]:
        """Get parent class IDs for multiple class nodes."""
        if self._class_service._class_extend_repo is None:
            return {}
        return await self._class_service._class_extend_repo.get_extended_classes_batch(node_ids)

    async def get_related_ids_batch(
        self, node_ids: list[int], relation_type: str
    ) -> dict[int, list[int]]:
        """Get related IDs for multiple nodes (tags, aliases, or classes)."""
        if relation_type == "tags":
            return await self.get_tag_link_targets_batch(node_ids)
        if relation_type == "aliases":
            return await self.get_alias_node_ids_batch(node_ids)
        if relation_type == "classes":
            return await self.get_class_ids_batch(node_ids)
        raise ValueError(f"Unknown relation_type: {relation_type!r}")

    async def get_effective_class_ids_batch(self, node_ids: list[int]) -> dict[int, list[int]]:
        """Get class_ids for multiple nodes including inherited classes from extends."""
        explicit_classes = await self._node_repo.get_class_ids_batch(node_ids)
        if not explicit_classes:
            return {nid: [] for nid in node_ids}

        all_explicit_class_ids = set()
        for class_list in explicit_classes.values():
            all_explicit_class_ids.update(class_list)

        if not all_explicit_class_ids:
            return explicit_classes

        class_extend_repo = self._class_service._class_extend_repo
        if class_extend_repo is None:
            return explicit_classes

        extension_service = ClassExtensionService(
            self._workspace_id or 0,
            self._property_repo,
            class_extend_repo,
            self._node_repo,
        )

        extends_cache: dict[int, list[int]] = {}
        for class_id in all_explicit_class_ids:
            try:
                extended = await extension_service.get_all_extended_classes(class_id)
                extends_cache[class_id] = extended[1:] if len(extended) > 1 else []
            except (ValueError, RecursionError):
                extends_cache[class_id] = []

        result: dict[int, list[int]] = {}
        for node_id in node_ids:
            explicit = explicit_classes.get(node_id, [])
            effective = list(explicit)
            for class_id in explicit:
                for inherited_class in extends_cache.get(class_id, []):
                    if inherited_class not in effective:
                        effective.append(inherited_class)
            result[node_id] = effective

        return result

    async def resolve_referenced_display_names(self, target_rows: list[Any]) -> dict[str, str]:
        """Resolve node links embedded in names."""
        return await self._node_repo.resolve_referenced_display_names(target_rows)

    async def get_node_breadcrumbs(self, node_id: int) -> list[Node]:
        """Get ancestor chain from root to node's immediate parent."""
        return await self._node_repo.get_breadcrumbs(node_id)

    async def get_node_properties(self, node_id: int):
        """Get all property values for a node."""
        return await self._property_repo.get_all_property_values(node_id)

    async def get_nodes_properties_batch(self, node_ids: list[int]):
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

    async def get_text_links(self, node_id: int):
        """Get all text links from a node."""
        return await self._link_service.get_text_links(node_id)

    async def get_text_links_batch(self, node_ids: list[int]):
        """Get text links for multiple nodes, grouped by source_id."""
        return await self._link_service.get_text_links_batch(node_ids)

    async def add_tag_link(self, source_node_id: int, target_node_id: int) -> None:
        """Add a tag to a node (idempotent)."""
        tag_ids = await self._node_repo.get_node_tag_ids(source_node_id)
        if target_node_id not in tag_ids:
            tag_ids.append(target_node_id)
            await self._node_repo.update_node_tag_ids(source_node_id, tag_ids)

    async def remove_tag_link(self, source_node_id: int, target_node_id: int) -> bool:
        """Remove a tag from a node."""
        tag_ids = await self._node_repo.get_node_tag_ids(source_node_id)
        if target_node_id not in tag_ids:
            return False
        tag_ids = [tid for tid in tag_ids if tid != target_node_id]
        await self._node_repo.update_node_tag_ids(source_node_id, tag_ids)
        return True

    async def get_property_backlinks(self, node_id: int):
        """Get pages that reference this node via date or node properties."""
        return await self._link_service.get_property_backlinks(node_id)

    async def get_alias_ids(self, target_node_id: int) -> list[int]:
        """Get IDs of nodes that are aliases of the target node."""
        return await self._link_service.get_alias_ids(target_node_id)

    async def add_alias(self, target_node_id: int, alias_node_id: int) -> None:
        """Add a page as an alias of the target node."""
        await self._link_service.add_alias(target_node_id, alias_node_id)

    async def remove_alias(self, target_node_id: int, alias_node_id: int) -> bool:
        """Remove an alias from a node."""
        return await self._link_service.remove_alias(target_node_id, alias_node_id)

    async def rebuild_all_links(self) -> dict:
        """Rebuild all node_link records from AST content."""
        return await self._link_service.rebuild_all_links()

    async def fix_raw_uuid_links(self) -> dict:
        """Find raw [[uuid]] text in AST content and convert to proper node_link AST nodes."""
        return await self._link_service.fix_raw_uuid_links()

    async def fix_links_for_uuid(self, target_uuid: str) -> dict:
        """Fix broken_link and raw [[uuid]] references pointing to a specific UUID."""
        return await self._link_service.fix_links_for_uuid(target_uuid)

    def row_to_node(self, row) -> Node:
        """Convert a raw DB row to a Node entity."""
        return self._node_repo.row_to_node(row)

    async def create_raw_node(self, data: NodeCreateData, uuid: str | None = None) -> Node:
        """Create a node directly via repository, bypassing link parsing.

        Used for system-managed nodes (date pages, assets) where the UUID is
        predetermined and normal validation / link-parsing is not needed.
        """
        if self._user_id:
            has_workspace_create = await self.permissions.can_create_in_workspace(self._workspace_id)
            has_parent_write = False
            if data.parent_id is not None:
                has_parent_write = await self.permissions.can_write_node(data.parent_id)
            if not has_workspace_create and not has_parent_write:
                await self.permissions.require_workspace_create(self._workspace_id)
        return await self._node_repo.create(data, uuid=uuid)

    async def _compute_flags_from_classes(self, class_ids: list[int]) -> dict[str, bool]:
        """Delegate to ClassManagementService."""
        return await self._class_service.compute_flags_from_classes(class_ids)

    async def _update_flags_from_classes(self, node_id: int, class_ids: list[int]) -> None:
        """Delegate to ClassManagementService."""
        await self._class_service.update_flags_from_classes(node_id, class_ids)

    async def _validate_page_name_uniqueness(
        self,
        name: str,
        parent_id: int | None,
        classes: list[int],
        exclude_node_id: int | None = None,
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
            rows = [r for r in rows if r["id"] != exclude_node_id]

        if not rows:
            return

        # Group by node to get each existing page's classes
        existing_pages: dict[int, list[tuple]] = {}
        for row in rows:
            node_id = row["id"]
            if node_id not in existing_pages:
                existing_pages[node_id] = []
            if row["class_id"]:
                existing_pages[node_id].append((row["class_id"], row["class_name"]))

        # Check each existing page for class overlap
        for _node_id, existing_classes in existing_pages.items():
            existing_class_ids = {c[0] for c in existing_classes}
            overlap = set(classes) & existing_class_ids

            if overlap:
                # Found conflict - get class names for error message
                conflicting_class_names = [c[1] for c in existing_classes if c[0] in overlap]
                raise DuplicateNodeError(name, conflicting_class_names)

    async def _create_hierarchical_page(
        self,
        data: NodeCreateData,
        user_id: int | None = None,
    ) -> Node:
        """Create a page with hierarchical path (name contains '/').

        For a name like "Projects/Work/Q1 Planning", this will:
        1. Create or find "Projects" as a root page
        2. Create or find "Work" as a child of "Projects"
        3. Create "Q1 Planning" as a child of "Work"
        4. Return the leaf node

        All intermediate pages inherit the classes from the original request.
        """
        if not data.name or "/" not in data.name:
            raise ValueError("Name must contain '/' for hierarchical creation")

        # Split the path into segments
        segments = [s.strip() for s in data.name.split("/") if s.strip()]

        if not segments:
            raise ValueError("Empty path after splitting")

        # Use provided classes or default to page class
        classes = data.classes if data.classes else [self._page_class_id]

        # Walk through segments, creating or finding each parent
        current_parent_id: int | None = None

        for i, segment in enumerate(segments):
            is_leaf = i == len(segments) - 1

            # Check if a page with this name already exists at this level
            existing = await self._node_repo.find_page_by_name(segment, current_parent_id)
            row = existing[0] if existing else None

            if row:
                # Page exists, use it as parent for next iteration
                current_parent_id = row["id"]
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
                    if self._mention_service is not None:
                        await self._mention_service.reindex_source(new_page.id)

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
        user_id: int | None = None,
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
        is_page = flags.get("is_page", False)

        # Disable hierarchical creation for date pages
        is_date_page = flags.get("is_day", False) or flags.get("is_month", False) or flags.get("is_year", False)

        # Handle hierarchical page creation (name contains '/') - but not for date pages
        if is_page and data.name and "/" in data.name and not data.parent_id and not is_date_page:
            return await self._create_hierarchical_page(data, user_id)

        # Validate input
        validate_node_create(data.name, data.icon, data.color)

        # Validate parent_id exists when provided
        if data.parent_id is not None:
            parent = await self._node_repo.get_by_id(data.parent_id)
            if parent is None:
                raise NodeValidationError(
                    f"Parent node does not exist: {data.parent_id}",
                    field="parent_id",
                )

        # Validate page name uniqueness if it's a page with classes
        if is_page and data.classes:
            await self._validate_page_name_uniqueness(
                name=data.name,
                parent_id=data.parent_id,
                classes=data.classes,
            )

        # Create the node
        if self._user_id:
            has_workspace_create = await self.permissions.can_create_in_workspace(self._workspace_id)
            has_parent_write = False
            if data.parent_id is not None:
                has_parent_write = await self.permissions.can_write_node(data.parent_id)
            if not has_workspace_create and not has_parent_write:
                await self.permissions.require_workspace_create(self._workspace_id)
        node = await self._node_repo.create(data, user_id)

        # Parse and store links and inline classes from content
        if node.name and node.id is not None:
            await self._link_service.update_node_links(node.id, node.name)
            await self._link_service.update_inline_classes(node.id, node.name)
            if self._mention_service is not None:
                await self._mention_service.reindex_source(node.id)

        # Log activity
        if node.id is not None:
            await self._log_activity(node.id, "created", f"{'Page' if node.is_page else 'Block'} created")

        # Re-fetch to get updated version after side effects
        if node.id is not None:
            refreshed = await self._node_repo.get_by_id(node.id)
            if refreshed:
                node = refreshed

        # Apply Class properties if any classes have associated properties with defaults
        if node.id is not None and data.classes:
            from ..entities.property import RELATION_TYPES, SCALAR_TYPES, PropertyType

            # Gather all class-property associations for all classes at once,
            # then deduplicate property fetches so each unique property is
            # fetched at most once even when shared across multiple classes.
            all_cp_list = []
            for class_id in data.classes:
                class_properties = await self._property_repo.get_class_properties(class_id)
                all_cp_list.extend(class_properties)

            # Build a cache of property objects keyed by property_id
            prop_cache: dict[int, Any] = {}
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
                                    NodeCreateData(
                                        name=serialize_ast(parse_ast(str(default), ParseMode.PLAIN)), parent_id=node.id
                                    ),
                                    user_id,
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
        icon: str | None = None,
        color: str | None = None,
        additional_classes: list[int] | None = None,
        user_id: int | None = None,
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
        user_id: int | None = None,
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
        user_id: int | None = None,
    ) -> Node | None:
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
            await self._log_activity(node.id, "moved", f"Moved to parent {new_parent_id}")

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

        # Use recursive CTE to check if new_parent is a descendant of node
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
        user_id: int | None = None,
    ) -> Node | None:
        """Update an existing node.

        Validates input fields.
        Validates page name uniqueness if name or classes change.
        If name changes, re-parses links.
        If parent_id changes, updates classes path (inherited classes may change).

        Args:
            node_id: ID of node to update
            data: Update data
            user_id: User performing the update
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

        # Optimistic locking: check expected_version before proceeding
        if data.expected_version is not None and old_node.version != data.expected_version:
            from ..errors import OptimisticLockError
            raise OptimisticLockError(
                node_id=str(node_id),
                expected_version=data.expected_version,
                actual_version=old_node.version,
            )

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
        node = await self._node_repo.update(node_id, data, user_id)
        if not node:
            return None

        # Log activity for content edits
        if node.id is not None and data.name is not None:
            await self._log_activity(node.id, "edited")

        # Re-parse links and inline classes if name changed
        if data.name is not None and node.id is not None:
            await self._link_service.update_node_links(node.id, node.name)
            await self._link_service.update_inline_classes(node.id, node.name)
            if self._mention_service is not None:
                await self._mention_service.reindex_source(node.id)

        # Update classes path if parent changed (inherited classes may have changed)
        if data.parent_id is not None and data.parent_id != old_parent_id and node.id is not None:
            await self._link_service.update_classes_path(node.id)
            await self._log_activity(node.id, "moved", f"Moved to parent {data.parent_id}")

        return node

    async def delete_node(self, node_id: int, user_id: int | None = None) -> bool:
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
        logger.debug("[DELETE] Node %s has %s backlinks", node_id, len(backlinks))

        # Track nodes we've updated to avoid double-processing
        updated_nodes = set()

        # Update each source node to remove/replace the link
        for link in backlinks:
            logger.debug("[DELETE] Processing backlink from source_node_id=%s", link.source_node_id)
            source_node = await self._node_repo.get_by_id(link.source_node_id)
            if not source_node or not source_node.name:
                logger.debug("[DELETE] Source node %s not found or has no name", link.source_node_id)
                continue

            logger.debug("[DELETE] Updated source node %s", link.source_node_id)

            # Replace the link in the source node's content
            updated_content = await self._remove_link_from_content(
                source_node.name,
                node,
                "page",  # link_type is no longer used but kept for signature compatibility
            )

            logger.debug(
                "[DELETE] Updated content for node %s (changed=%s)",
                link.source_node_id,
                updated_content != source_node.name,
            )

            if updated_content != source_node.name:
                # Update without re-parsing links (to avoid infinite recursion)
                await self._node_repo.update(link.source_node_id, NodeUpdateData(name=updated_content))
                updated_nodes.add(link.source_node_id)

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
        logger.info("Deleted node %s and %s descendants", node_id, len(descendant_ids))

        # Log activity
        await self._log_activity(node_id, "archived" if node.is_page else "deleted", f"{'Page' if node.is_page else 'Block'} deleted")

        # Remove from all users' favorites
        await self._cleanup_favorites(node_id)

        # NOTE: Asset files are NOT deleted on soft-delete.
        # They are cleaned up by the asset cleanup job or deleted on hard-delete.

        return True

    async def restore_node(self, node_id: int, user_id: int | None = None) -> Node | None:
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

        # Log activity
        await self._log_activity(node_id, "unarchived", "Restored from trash")

        return await self._node_repo.get_by_id(node_id)

    async def get_deleted_nodes(self) -> list[Node]:
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
        logger.debug("[PERM_DELETE] Node %s has %s backlinks", node_id, len(backlinks))

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
                await self._node_repo.update(link.source_node_id, NodeUpdateData(name=updated_content))
                updated_nodes.add(link.source_node_id)
                logger.debug("[PERM_DELETE] Updated source node %s", link.source_node_id)

        # Also handle inline class references ({{nodeId}})
        await self._replace_inline_class_references(node, updated_nodes)

        result = await self._node_repo.hard_delete(node_id)

        # Remove from all users' favorites
        await self._cleanup_favorites(node_id)

        # If this is an asset node, delete the asset folder on hard-delete
        if node.is_asset and node.uuid:
            try:
                from ...domain.services.asset_service import AssetFileService

                workspace_uuid = await get_workspace_uuid(self._workspace_id)
                if workspace_uuid:
                    asset_file_service = AssetFileService(workspace_uuid)
                    asset_file_service.delete_asset(node.uuid)
                    logger.info("Deleted asset folder for node %s", node_id)
            except Exception as e:
                logger.error(f"[PERM_DELETE] Failed to delete asset folder for node {node_id}: {e}", exc_info=True)

        return result

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
        ids: list[int],
    ) -> list[dict]:
        """Permanently delete multiple nodes from trash by ID.

        Each ID is processed independently — failures on one do not prevent
        the others from being deleted. Only works on nodes already in trash.

        Returns a list of dicts: { "success": bool, "error": str|None }
        """
        results: list[dict] = []
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
            updated_content = await self._remove_link_from_content(source_node.name, node, "class")

            if updated_content != source_node.name:
                await self._node_repo.update(ref.source_id, NodeUpdateData(name=updated_content))

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

        """
        import json as _json

        # ── AST JSON path (modern content) ────────────────────────────────
        try:
            ast = _json.loads(content)
            if isinstance(ast, list) and (not ast or isinstance(ast[0], dict)):
                # Compute the target's plain-text name once (used when no custom label)
                target_text = ""
                if target_node.name:
                    try:
                        target_name_ast = parse_ast(target_node.name)
                        target_text = stringify_ast(target_name_ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
                    except (ValueError, TypeError):
                        target_text = ""

                target_uuid = target_node.uuid or ""
                target_id_str = str(target_node.id)

                def _replace_in_nodes(nodes: list) -> tuple:
                    """Return (new_nodes, changed_flag)."""
                    result: list = []
                    changed = False
                    for node_item in nodes:
                        if not isinstance(node_item, dict):
                            result.append(node_item)
                            continue

                        if node_item.get("type") == "node_link":
                            link_id = str(node_item.get("link_id", ""))
                            node_identifier = link_id.split(":", 1)[0]
                            if node_identifier and (node_identifier in (target_uuid, target_id_str)):
                                changed = True
                                label = node_item.get("label")
                                if preserve_as_broken:
                                    broken = {"type": "broken_link", "link_id": link_id}
                                    if label:
                                        broken["label"] = label
                                    result.append(broken)
                                else:
                                    replacement_text = label if label else target_text
                                    result.append({"type": "text", "text": replacement_text})
                                continue

                        if "children" in node_item:
                            new_children, child_changed = _replace_in_nodes(node_item["children"])
                            if child_changed:
                                changed = True
                                node_item = {**node_item, "children": new_children}

                        result.append(node_item)
                    return result, changed

                new_ast, changed = _replace_in_nodes(ast)
                if changed:
                    return _json.dumps(new_ast)
                return content
        except (_json.JSONDecodeError, TypeError):
            pass

        return content

    async def _remove_node_from_class_tag_properties(self, node_id: int) -> None:
        """Remove a node from any class/tag property values where it's referenced.

        When a node used as a class or tag is deleted, remove it from all nodes
        that reference it via property values (especially NODE type properties).
        The inline text references {{nodeId}} are handled separately.
        """
        deleted_count = await self._property_repo.delete_relation_values_by_target(node_id)
        if deleted_count > 0:
            logger.debug("Removed node %s from %s property value relations", node_id, deleted_count)

        # Remove from node.tag_ids arrays
        tag_cleanup_count = await self._node_repo.remove_tag_id_from_all_nodes(node_id)
        if tag_cleanup_count > 0:
            logger.debug("Removed node %s from %s node tag arrays", node_id, tag_cleanup_count)

    async def _redirect_tag_ids(self, old_tag_id: int, new_tag_id: int) -> int:
        """Replace old_tag_id with new_tag_id in all node.tag_ids arrays."""
        return await self._node_repo.redirect_tag_ids(old_tag_id, new_tag_id)

    async def _count_active_day_descendants(self, node_id: int) -> int:
        """Count active day pages that are descendants of this node.

        Used to prevent deletion of month/year pages that have active daily pages.

        Args:
            node_id: The ID of the month or year node to check

        Returns:
            Number of active day pages that are descendants of this node
        """
        return await self._node_repo.count_active_day_descendants(node_id)

    async def _cleanup_favorites(self, node_id: int) -> None:
        """Remove a node from all users' favorites.

        Favorites are stored as JSON arrays in setting_user(key='favorites').
        This removes the node ID from every user's favorites list.
        """
        if not self._settings_repo:
            return
        try:
            await self._settings_repo.remove_node_from_favorites(node_id)
        except Exception as e:
            logger.debug("Failed to clean up favorites for node %s: %s", node_id, e)

    async def list_templates(self) -> list[Node]:
        """List all template nodes in this workspace."""
        return await self._node_repo.list_templates()

    async def extract_template_variables(self, node_id: int) -> list[str]:
        """Extract {{variable_name}} placeholders from a node and all its descendants."""
        import re

        template_node = await self._node_repo.get_by_id(node_id)
        if not template_node:
            return []
        descendants = await self._node_repo.get_template_descendants(node_id)
        all_names = [template_node.name] + [d.name for d in descendants]

        pattern = re.compile(r"\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}")
        seen: set = set()
        variables: list[str] = []
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
        parent_id: int | None = None,
        name: str | None = None,
        variables: dict[str, str] | None = None,
        as_blocks: bool = False,
        after_id: int | None = None,
    ) -> dict[str, Any]:
        """Create a deep copy of a template node tree.

        Rewrites internal link_id references and substitutes {{variable}} placeholders.
        When as_blocks=True the template root is omitted and its direct children
        are placed under parent_id instead.  When after_id is set, existing
        siblings are shifted to make room and the new blocks are sequenced
        starting after the after_id node.
        """
        import uuid as uuid_module

        # 1. Load the template root
        template_node = await self._node_repo.get_by_id(template_id)
        if not template_node or not template_node.is_template:
            raise ValueError(f"Node {template_id} is not a template")

        # 2. Load all descendants ordered by depth then sequence
        desc_nodes = await self._node_repo.get_template_descendants(template_id)
        logger.info(
            f"[TEMPLATE] template_id={template_id}, desc_nodes count={len(desc_nodes)}, names={[n.name[:30] if n.name else '' for n in desc_nodes]}"
        )

        # 3. Look up the template class DB id so we can strip it from copies
        template_class_uuid = SYSTEM_CLASS_UUIDS.get("template", "")
        template_class_db_id = await self._node_repo.find_node_id_by_uuid(template_class_uuid)

        # 4. Build old-id → new-uuid mapping for every node in the tree
        all_old_ids = [template_node.id] + [n.id for n in desc_nodes]
        old_id_to_new_uuid: dict[int, str] = {old_id: str(uuid_module.uuid4()) for old_id in all_old_ids}

        # old string UUID → new string UUID (for content rewriting)
        old_uuid_to_new_uuid: dict[str, str] = {}
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
                    result = result.replace("{{" + var_name + "}}", var_value)
            return result

        # 5. Strip template class from root's class_ids
        root_classes = [c for c in list(template_node.class_ids or []) if c != template_class_db_id]

        # 6. Create nodes — root first (unless as_blocks), then descendants depth-first
        old_id_to_new_id: dict[int, int] = {}

        # When as_blocks + after_id, compute a sequence offset so the new
        # top-level children are inserted right after the anchor block.
        seq_offset = 0
        if as_blocks and after_id is not None and parent_id is not None:
            anchor_seq = await self._node_repo.get_node_sequence(after_id)
            if anchor_seq is not None:
                # Count how many direct template children will be inserted
                direct_count = sum(1 for n in desc_nodes if n.parent_id == template_node.id)
                # Shift existing siblings that come after the anchor
                await self._node_repo.shift_sequences(parent_id, anchor_seq, direct_count)
                seq_offset = anchor_seq + 1

        if not as_blocks:
            root_name = substitute_content(name or template_node.name or "")
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
                name=substitute_content(node.name or ""),
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
            from ..entities.property import RELATION_TYPES, SCALAR_TYPES, PropertyType

            for prop_id, prop_data in template_props.items():
                prop = prop_data.get("property")
                values = prop_data.get("values", [])
                if not prop or not values:
                    continue
                try:
                    for val in values:
                        if prop.type in SCALAR_TYPES:
                            scalar = (
                                val.value_integer
                                if getattr(val, "value_integer", None) is not None
                                else val.value_float
                                if getattr(val, "value_float", None) is not None
                                else val.value_boolean
                                if getattr(val, "value_boolean", None) is not None
                                else getattr(val, "value_text", None)
                            )
                            if scalar is not None:
                                await self._property_repo.set_scalar_value(new_root_id, prop_id, scalar)
                        elif prop.type in RELATION_TYPES:
                            target = getattr(val, "target_id", None)
                            if target is not None:
                                await self._property_repo.set_relation_value(new_root_id, prop_id, target)
                        elif prop.type == PropertyType.SELECTION:
                            sel_id = getattr(val, "selection_line_id", None)
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
            return {"node": None, "blocks": block_nodes, "as_blocks": True}
        else:
            root_node = await self._node_repo.get_by_id(old_id_to_new_id[template_node.id])
            return {"node": root_node, "blocks": [], "as_blocks": False}

    async def _resolve_alias(self, node: Node | None) -> Node | None:
        """If the node is an alias, return the target node instead."""
        if node and node.aliased_id:
            target = await self._node_repo.get_by_id(node.aliased_id)
            if target:
                return target
        return node

    async def _log_activity(
        self,
        node_id: int,
        action: str,
        details: str | None = None,
        target_node_id: int | None = None,
    ) -> None:
        """Log an activity entry for a node.

        Delegates to the injected activity repository so the domain service
        never executes SQL directly. Silently ignores errors so activity
        logging never breaks user operations.
        """
        if self._activity_repo is None or self._workspace_id is None or self._user_id is None:
            return
        try:
            from datetime import UTC, datetime

            now = datetime.now(UTC)
            await self._activity_repo.create_node_activity(
                node_id, action, details, target_node_id, now, self._user_id
            )
        except (ValueError, TypeError, LookupError):
            # Activity logging must never fail the user operation
            pass

    async def get_node(self, node_id: int) -> Node | None:
        """Get a node by ID (resolves aliases transparently)."""
        node = await self._node_repo.get_by_id(node_id)
        return await self._resolve_alias(node)

    async def get_nodes_batch(self, node_ids: list[int]) -> dict[int, Node]:
        """Get multiple nodes by ID in a single query (resolves aliases transparently).

        Returns a dict mapping node_id -> Node.
        """
        if not node_ids:
            return {}
        nodes = await self._node_repo.get_by_ids(node_ids)
        result: dict[int, Node] = {}
        alias_ids: list[int] = []
        alias_map: dict[int, int] = {}  # aliased_id -> original node_id
        for node in nodes:
            if node.aliased_id:
                alias_ids.append(node.aliased_id)
                alias_map[node.aliased_id] = node.id
            else:
                if node.id is not None:
                    result[node.id] = node
        if alias_ids:
            targets = await self._node_repo.get_by_ids(alias_ids)
            for target in targets:
                if target.id is not None:
                    original_id = alias_map.get(target.id)
                    if original_id is not None:
                        result[original_id] = target
        return result

    async def get_node_by_uuid(self, uuid: str) -> Node | None:
        """Get a node by UUID (resolves aliases transparently)."""
        node = await self._node_repo.get_by_uuid(uuid)
        return await self._resolve_alias(node)

    async def get_node_with_properties(self, node_id: int) -> dict[str, Any] | None:
        """Get a node with all its property values."""
        node = await self._node_repo.get_by_id(node_id)
        if not node:
            return None

        properties = await self._property_repo.get_node_properties(node_id)

        return {
            "node": node,
            "properties": properties,
        }

    async def get_all_pages(self, limit: int = 1000, offset: int = 0) -> list[Node]:
        """Get pages, paginated."""
        return await self._node_repo.get_all_pages(limit=limit, offset=offset)

    async def get_page_content(self, page_id: int) -> dict[str, Any] | None:
        """Get a page with all its blocks and properties."""
        page = await self._node_repo.get_by_id(page_id)
        if not page:
            return None

        # Get all blocks belonging to this page
        blocks = await self._node_repo.get_page_content(page_id)

        # Get backlinks
        backlinks = await self._link_service.get_backlinks(page_id)

        return {
            "page": page,
            "blocks": blocks,
            "backlinks": backlinks,
        }

    async def find_user_id_by_page_node_uuid(self, node_uuid: str) -> int | None:
        """Find the user ID whose profile page has the given node UUID."""
        if self._user_repo is None:
            return None
        return await self._user_repo.get_user_id_by_page_node_uuid(node_uuid)

    async def get_node_suggestions(
        self,
        class_filters: str | None,
        limit: int,
    ) -> tuple[list[Node], list[Node]]:
        """Return suggested pages for node pickers.

        Optionally filtered by a comma-separated list of class IDs, expanded
        to include all subclasses.
        """
        class_filter_ids: list[int] = []
        if class_filters:
            class_filter_ids = [
                int(c.strip())
                for c in class_filters.split(",")
                if c.strip().isdigit()
            ]

        if class_filter_ids and self._class_service._class_extend_repo is not None:
            from .class_extension_service import ClassExtensionService

            extension_service = ClassExtensionService(
                self._workspace_id,
                self._property_repo,
                self._class_service._class_extend_repo,
                self._node_repo,
            )
            expanded: set[int] = set()
            for class_id in class_filter_ids:
                try:
                    chain = await extension_service.get_all_extended_classes(class_id)
                    expanded.update(chain)
                except (ValueError, LookupError, RecursionError):
                    expanded.add(class_id)
            class_filter_ids = list(expanded)

        return await self._node_repo.get_node_suggestions(
            class_filter_ids or None, limit
        )

    async def get_archived_pages_paginated(
        self, page: int, page_size: int
    ) -> tuple[list[Node], int]:
        """Get archived pages with total count."""
        return await self._node_repo.get_archived_pages_paginated(page, page_size)

    async def list_templates_paginated(
        self, page: int, page_size: int
    ) -> tuple[list[Node], int]:
        """List active templates with total count."""
        return await self._node_repo.list_templates_paginated(page, page_size)

    async def clear_scratchpad(self, user_id: int) -> dict[str, Any]:
        """Hard-delete all children of the Scratchpad system page.

        Creates the scratchpad page if it does not already exist.
        """
        from ...db.schema.constants import SYSTEM_PAGE_UUIDS

        scratchpad_uuid = SYSTEM_PAGE_UUIDS["scratchpad"]
        scratchpad = await self._node_repo.get_by_uuid(scratchpad_uuid)

        if scratchpad is None or scratchpad.id is None:
            await self.create_page("Scratchpad", user_id=user_id)
            return {"status": "ok", "deleted_count": 0}

        child_ids = await self._node_repo.get_descendants(
            scratchpad.id, include_self=False
        )
        if not child_ids:
            return {"status": "ok", "deleted_count": 0}

        await self._node_repo.hard_delete_nodes(child_ids)
        return {"status": "ok", "deleted_count": len(child_ids)}

    async def get_node_breadcrumbs_with_resolved_links(
        self, node_id: int
    ) -> list[dict[str, Any]]:
        """Get ancestor breadcrumb chain with resolved link display names."""
        import re

        from ...domain.stringify_ast import (
            NodeLinkResolution,
            StringifyMode,
            StringifyOptions,
            parse_ast,
            stringify_ast,
        )

        node = await self.get_node(node_id)
        breadcrumb_target_id = node_id
        if node and node.aliased_id:
            breadcrumb_target_id = node.aliased_id

        breadcrumb_nodes = await self.get_node_breadcrumbs(breadcrumb_target_id)

        link_node_uuids: set[str] = set()
        for breadcrumb_node in breadcrumb_nodes:
            if breadcrumb_node.name:
                for match in re.finditer(r'"link_id"\s*:\s*"([^"]+)"', breadcrumb_node.name):
                    link_id = match.group(1)
                    colon = link_id.find(":")
                    node_uuid = link_id[:colon] if colon > 0 else link_id
                    link_node_uuids.add(node_uuid)

        link_target_map: dict[str, Any] = {}
        if link_node_uuids:
            target_nodes = await self.get_nodes_by_uuids(list(link_node_uuids))
            for target in target_nodes.values():
                if target.name:
                    link_target_map[target.uuid] = parse_ast(target.name)

        def _resolve_link(link_id: str):
            colon = link_id.find(":")
            node_uuid = link_id[:colon] if colon > 0 else link_id
            target_ast = link_target_map.get(node_uuid)
            if target_ast is None:
                return None
            return NodeLinkResolution(
                target_ast=target_ast,
                label=None,
                target_id=node_uuid,
            )

        opts = StringifyOptions(
            mode=StringifyMode.TEXT_ONLY,
            resolve_node_link=_resolve_link if link_target_map else None,
        )

        items: list[dict[str, Any]] = []
        for breadcrumb_node in breadcrumb_nodes:
            if breadcrumb_node.id == breadcrumb_target_id:
                continue
            raw_name = breadcrumb_node.name or ""
            display = stringify_ast(parse_ast(raw_name), opts)
            items.append(
                {
                    "id": breadcrumb_node.id or 0,
                    "name": raw_name,
                    "display_name": display or "Untitled",
                    "icon": breadcrumb_node.icon,
                    "is_page": breadcrumb_node.is_page,
                    "parent_locked": breadcrumb_node.parent_locked,
                }
            )

        return items

    async def load_node_children(
        self,
        node_id: int,
        include_properties: bool = False,
    ) -> dict[str, Any]:
        """Load all descendant data needed to build the children response tree.

        Returns descendants ordered by depth/sequence, the parent-child map for
        has_children calculation, backlink counts, referenced target nodes, and
        optionally extracted property values.
        """
        all_descendants = await self._node_repo.get_descendants_ordered(node_id)

        # Filter out text-property value blocks and their subtrees
        all_desc_ids = [d.id for d in all_descendants if d.id is not None]
        text_prop_ids: set[int] = set()
        if all_desc_ids:
            text_prop_ids = await self._property_repo.get_text_property_target_ids(
                all_desc_ids
            )

        if text_prop_ids:
            excluded: set = set()
            filtered: list[Node] = []
            for d in all_descendants:
                if d.id in text_prop_ids or d.parent_id in excluded:
                    if d.id is not None:
                        excluded.add(d.id)
                    continue
                filtered.append(d)
            all_descendants = filtered

        # Prune collapsed subtrees
        collapsed_ids: set = set()
        children_of: dict[int, list] = {}
        visible_descendants: list[Node] = []

        for d in all_descendants:
            if d.id is None:
                continue
            pid = d.parent_id
            if pid is not None:
                children_of.setdefault(pid, []).append(d.id)

            if pid in collapsed_ids:
                collapsed_ids.add(d.id)
                continue

            visible_descendants.append(d)

            if d.collapsed:
                collapsed_ids.add(d.id)

        descendant_ids = [d.id for d in visible_descendants if d.id is not None]

        backlink_counts: dict[int, int] = {}
        if descendant_ids:
            backlink_counts = await self._link_service._link_repo.get_backlink_counts(
                descendant_ids
            )

        node_properties_map: dict[int, dict[str, Any]] = {}
        if include_properties and descendant_ids:
            batch_result = await self.get_nodes_properties_batch(descendant_ids)
            for nid, prop_data in batch_result.items():
                node_properties_map[nid] = prop_data

        referenced_nodes: list[Node] = []
        all_source_ids = [node_id] + descendant_ids
        if all_source_ids:
            target_ids = await self._link_service._link_repo.get_text_link_targets_batch(
                all_source_ids
            )
            if target_ids:
                referenced_nodes = await self._node_repo.get_by_ids(target_ids)

        return {
            "descendants": visible_descendants,
            "children_of": children_of,
            "backlink_counts": backlink_counts,
            "referenced_nodes": referenced_nodes,
            "node_properties_map": node_properties_map,
        }

    async def load_page_references(
        self,
        page_id: int,
        block_ids: list[int],
    ) -> dict[str, Any]:
        """Load backlink counts and referenced nodes for a page and its blocks."""
        backlink_counts: dict[int, int] = {}
        if block_ids:
            backlink_counts = await self._link_service._link_repo.get_backlink_counts(
                block_ids
            )

        referenced_nodes: list[Node] = []
        all_source_ids = [page_id] + block_ids
        if all_source_ids:
            target_ids = await self._link_service._link_repo.get_text_link_targets_batch(
                all_source_ids
            )
            if target_ids:
                referenced_nodes = await self._node_repo.get_by_ids(target_ids)

        return {
            "backlink_counts": backlink_counts,
            "referenced_nodes": referenced_nodes,
        }

    async def mark_page_opened(self, node_id: int) -> str:
        """Mark a page as opened and return the ISO-formatted open_date."""
        node = await self._node_repo.get_by_id(node_id)
        if node is None:
            raise ValueError("Node not found")
        if not node.is_page:
            raise ValueError("Only pages can have open_date updated")

        updated = await self._node_repo.update_open_date(node_id)
        if updated is None or updated.open_date is None:
            now = datetime.now(UTC)
            return now.isoformat()
        return updated.open_date

    async def get_node_versions(self, node_id: int, limit: int) -> list[dict[str, Any]]:
        """Get version history for a node."""
        rows = await self._node_repo.get_node_versions(node_id, limit)
        return [
            {
                "id": row["id"],
                "name": row["name"],
                "created_at": (
                    row["created_at"].isoformat() if row["created_at"] else None
                ),
                "user": row["username"],
            }
            for row in rows
        ]

    async def restore_node_version(
        self, node_id: int, version_id: int, user_id: int
    ) -> Node | None:
        """Restore a node to a previous version's content."""
        version_name = await self._node_repo.get_node_version(
            node_id, version_id
        )
        if version_name is None:
            return None

        updated = await self.update_node(
            node_id, NodeUpdateData(name=version_name), user_id=user_id
        )
        return updated

    async def get_node_including_archived(self, node_id: int) -> Node | None:
        """Get a node by ID including archived and deleted rows."""
        return await self._node_repo.get_node_by_id_with_workspace(node_id)

    async def get_delete_undo_state(self, node_id: int) -> dict[str, Any] | None:
        """Capture the undo state for a node deletion including descendant IDs."""
        node = await self.get_node_including_archived(node_id)
        if not node:
            return None

        desc_ids = await self._node_repo.get_all_descendants(
            node_id, include_self=False
        )
        return {
            "name": node.name,
            "icon": node.icon,
            "color": node.color,
            "parent_id": node.parent_id,
            "sequence": node.sequence,
            "collapsed": node.collapsed,
            "deleted_ids": [node_id] + desc_ids,
        }

    async def delete_node_assets(self, node_uuid: str, workspace_id: int) -> None:
        """Delete any asset files stored for a node UUID."""
        from ...db.connection import get_workspace_assets_dir, get_workspace_uuid

        workspace_uuid = await get_workspace_uuid(workspace_id)
        if not workspace_uuid:
            return

        assets_dir = get_workspace_assets_dir(workspace_uuid)
        for asset_file in assets_dir.glob(f"{node_uuid}.*"):
            try:
                asset_file.unlink()
                logger.info("Deleted asset file %s", asset_file)
            except Exception as e:
                logger.warning("Failed to delete asset file %s: %s", asset_file, e)

    async def get_nodes_by_uuids(self, uuids: list[str]) -> dict[str, Node]:
        """Get nodes by UUID, returning a dict keyed by UUID."""
        if not uuids:
            return {}
        nodes = await self._node_repo.get_by_uuids(uuids)
        return {node.uuid: node for node in nodes if node.uuid}

    async def search(
        self,
        query: str,
        limit: int = 50,
        offset: int = 0,
        class_filters: list[int] | None = None,
        is_page: bool | None = None,
        is_class: bool | None = None,
        is_daily: bool | None = None,
        is_user_page: bool | None = None,
        sort_by: str = "write_date",
        order: str = "desc",
    ) -> list[Node]:
        """Search nodes by name with optional filters, sorting and pagination."""
        return await self._node_repo.search(
            query,
            limit=limit,
            offset=offset,
            class_filters=class_filters,
            is_page=is_page,
            is_class=is_class,
            is_daily=is_daily,
            is_user_page=is_user_page,
            sort_by=sort_by,
            order=order,
        )

    async def add_class(self, node_id: int, class_node_id: int, *, _system_call: bool = False) -> bool:
        """Add a class to a node. Delegates to ClassManagementService."""
        result = await self._class_service.add_class(
            node_id,
            class_node_id,
            _system_call=_system_call,
            _page_name_validator=self._validate_page_name_uniqueness,
        )
        if result:
            class_node = await self._node_repo.get_by_id(class_node_id)
            await self._log_activity(node_id, "type_added", f"Added class '{_format_node_name(class_node.name if class_node else None)}'")
        return result

    async def remove_class(self, node_id: int, class_node_id: int) -> bool:
        """Remove a class from a node. Delegates to ClassManagementService."""
        class_node = await self._node_repo.get_by_id(class_node_id)
        result = await self._class_service.remove_class(node_id, class_node_id)
        if result:
            await self._log_activity(node_id, "type_removed", f"Removed class '{_format_node_name(class_node.name if class_node else None)}'")
        return result

    async def get_node_classes(self, node_id: int) -> list[Node]:
        """Get all classes applied to a node. Delegates to ClassManagementService."""
        return await self._class_service.get_node_classes(node_id)

    async def merge_pages(
        self,
        source_id: int,
        target_id: int,
        user_id: int | None = None,
    ) -> dict[str, Any]:
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

        # Step 3: Reparent children
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
                    source_id,
                    source.uuid,
                    target_id,
                    target.uuid,
                )
                if updated != source_node.name:
                    await self._node_repo.update(bsid, NodeUpdateData(name=updated))

        # Step 5: Redirect structural backlinks in node_link table
        await self._link_service._link_repo.redirect_link_targets(source_id, target_id)
        logger.info(f"[MERGE] Redirected node_link backlinks from {source_id} to {target_id}")

        # Step 5a: Redirect tag_ids arrays that point to source to target
        await self._redirect_tag_ids(source_id, target_id)
        logger.info(f"[MERGE] Redirected tag_ids arrays from {source_id} to {target_id}")

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
        """Replace references to source node with target node in content."""
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

        return result

    async def archive_node(self, node_id: int, user_id: int | None = None) -> Node | None:
        """Archive a node and all its descendants (set active to false)."""
        from ...utils import utc_now

        now = utc_now()
        uid = user_id or self._user_id

        descendant_ids = await self._node_repo.get_descendants(node_id)
        all_node_ids = [node_id] + descendant_ids

        await self._node_repo.archive_nodes(all_node_ids, now, uid)
        logger.info(f"[ARCHIVE] Archived node {node_id} and {len(descendant_ids)} descendants")

        # Log activity
        await self._log_activity(node_id, "archived", "Archived")

        return await self._node_repo.get_by_id(node_id)

    async def unarchive_node(self, node_id: int, user_id: int | None = None) -> Node | None:
        """Unarchive a node and all its descendants (set active to true)."""
        from ...utils import utc_now

        now = utc_now()
        uid = user_id or self._user_id

        descendant_ids = await self._node_repo.get_descendants(node_id)
        all_node_ids = [node_id] + descendant_ids

        await self._node_repo.unarchive_nodes(all_node_ids, now, uid)
        logger.info(f"[UNARCHIVE] Unarchived node {node_id} and {len(descendant_ids)} descendants")

        # Log activity
        await self._log_activity(node_id, "unarchived", "Unarchived")

        return await self._node_repo.get_by_id(node_id)

    async def get_archived_pages(self) -> list[Node]:
        """Get all archived pages."""
        return await self._node_repo.get_archived_pages()

    # ==================== Batch Operations ====================

    async def batch_create_nodes(
        self,
        items: list[NodeCreateData],
        user_id: int | None = None,
        uuid_conflict_mode: str = "block",
    ) -> list[dict]:
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
        results: list[dict] = []
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
        uuids: list[str],
        user_id: int | None = None,
    ) -> list[dict]:
        """Delete multiple nodes by UUID in a single batch.

        Each UUID is resolved and deleted independently — failures on one
        do not prevent the others from being deleted.

        Returns a list of dicts: { "success": bool, "error": str|None }
        """
        results: list[dict] = []
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
                logger.debug("Failed to delete node %s: %s", uuid, e)
                results.append({"success": False, "error": str(e)})
        return results

    async def batch_update_nodes(
        self,
        items: list[dict],
        user_id: int | None = None,
    ) -> list[dict]:
        """Update multiple nodes in a single batch.

        Each item dict must have 'node_id' (int) and 'data' (NodeUpdateData).

        Failures on one item do not prevent the others from being updated.
        Results are returned in the same order as the input list.

        Returns a list of dicts: { "success": bool, "node": Node|None, "error": str|None }
        """
        results: list[dict] = []
        for item in items:
            try:
                node = await self.update_node(
                    item["node_id"],
                    item["data"],
                    user_id=user_id,
                )
                if not node:
                    results.append({"success": False, "node": None, "error": "Node not found"})
                else:
                    results.append({"success": True, "node": node, "error": None})
            except Exception as e:
                logger.warning(f"[BATCH_UPDATE] Failed to update node {item.get('node_id')}: {e}")
                results.append({"success": False, "node": None, "error": str(e)})
        return results
