"""Class management domain service.

Owns all class-related operations: flag computation, listing, searching,
and adding/removing classes from nodes.  Previously this logic was scattered
across NodeService, the classes router, and the postgres_node repository.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from app.domain.entities import Node, NodeCreateData, NodeUpdateData
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS
from app.domain.errors import SystemClassConstraintError
from app.domain.node_flags import CLASS_UUID_TO_FLAG, compute_node_flags
from app.domain.stringify_ast import ParseMode, parse_ast, serialize_ast
from app.features.nodes.class_extension_service import ClassExtensionService
from app.features.properties.attributes import default_value_from_columns
from app.logging_config import get_logger

if TYPE_CHECKING:
    from app.features.nodes.port import ClassExtendRepository, NodeRepository
    from app.features.properties.port import PropertyRepository

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Module-level constants (previously defined in node_service.py)
# ---------------------------------------------------------------------------

# Date-related classes managed by the system — cannot be added/removed manually
PROTECTED_DATE_CLASS_UUIDS = {
    SYSTEM_CLASS_UUIDS["year"],
    SYSTEM_CLASS_UUIDS["month"],
    SYSTEM_CLASS_UUIDS["day"],
}

# Classes that can only be applied to blocks, not pages
BLOCK_ONLY_CLASS_UUIDS = {
    SYSTEM_CLASS_UUIDS["query"],
    SYSTEM_CLASS_UUIDS["comment"],
    SYSTEM_CLASS_UUIDS["quote"],
    SYSTEM_CLASS_UUIDS["warning"],
    SYSTEM_CLASS_UUIDS["note"],
    SYSTEM_CLASS_UUIDS["tip"],
    SYSTEM_CLASS_UUIDS["info"],
    SYSTEM_CLASS_UUIDS["danger"],
    SYSTEM_CLASS_UUIDS["success"],
    SYSTEM_CLASS_UUIDS["cloze"],
}

# Full set of system class UUIDs for quick lookup
ALL_SYSTEM_CLASS_UUIDS = set(SYSTEM_CLASS_UUIDS.values())

# UUID of the 'class' class — cannot be stripped from system class nodes
CLASS_CLASS_UUID = SYSTEM_CLASS_UUIDS["class"]


class ClassManagementService:
    """Domain service that owns all class management operations.

    Responsibilities:
    - Flag computation (system class UUID → is_* boolean columns)
    - Listing and searching class nodes
    - Adding and removing classes from nodes (with system constraint checks)
    - Querying which classes a node has
    """

    def __init__(
        self,
        workspace_id: int,
        node_repo: NodeRepository,
        property_repo: PropertyRepository,
        class_extend_repo: ClassExtendRepository,
    ) -> None:
        self._workspace_id = workspace_id
        self._node_repo = node_repo
        self._property_repo = property_repo
        self._class_extend_repo = class_extend_repo

    @property
    def workspace_id(self) -> int | None:
        return self._workspace_id

    # ------------------------------------------------------------------
    # Flag computation
    # ------------------------------------------------------------------

    async def compute_flags_from_classes(self, class_ids: list[int]) -> dict[str, bool]:
        """Return the is_* flag dict implied by the given class IDs.

        Only system classes produce boolean flags; user-defined classes do not.
        """
        if not class_ids:
            return dict.fromkeys(CLASS_UUID_TO_FLAG.values(), False)
        class_nodes = await self._node_repo.get_by_ids(class_ids)
        return compute_node_flags(class_nodes)

    async def update_flags_from_classes(self, node_id: int, class_ids: list[int]) -> None:
        """Recompute and persist all is_* flags for *node_id* from *class_ids*.

        Triggers the repository's flag-recomputation path via a classes-only update.
        """
        update_data = NodeUpdateData(classes=class_ids)
        await self._node_repo.update(node_id, update_data)

    # ------------------------------------------------------------------
    # Listing / searching
    # ------------------------------------------------------------------

    async def list_classes(self) -> list[Node]:
        """Return all class nodes in the workspace, ordered by name."""
        return await self._node_repo.list_classes()

    async def search_classes(self, q: str, limit: int = 20) -> list[Node]:
        """Full-text + ILIKE search over class nodes."""
        return await self._node_repo.search_classes(q, limit)

    async def get_nodes_with_class(self, class_id: int, limit: int | None = None, offset: int | None = None) -> list[Node]:
        """Return all nodes that carry the given class (or any of its subclasses)."""
        extension_service = ClassExtensionService(
            self._workspace_id, self._property_repo, self._class_extend_repo, self._node_repo
        )
        subclass_ids = await extension_service.get_all_subclasses(class_id)
        all_class_ids = [class_id] + subclass_ids
        return await self._node_repo.get_nodes_with_classes(all_class_ids, limit=limit, offset=offset)

    async def count_nodes_with_class(self, class_id: int) -> int:
        """Count nodes that carry the given class (or any of its subclasses)."""
        extension_service = ClassExtensionService(
            self._workspace_id, self._property_repo, self._class_extend_repo, self._node_repo
        )
        subclass_ids = await extension_service.get_all_subclasses(class_id)
        all_class_ids = [class_id] + subclass_ids
        return await self._node_repo.count_nodes_with_classes(all_class_ids)

    # ------------------------------------------------------------------
    # Node-level class queries
    # ------------------------------------------------------------------

    async def get_node_classes(self, node_id: int) -> list[Node]:
        """Return all class nodes assigned to *node_id*."""
        class_ids = await self._node_repo.get_node_class_ids(node_id)
        if not class_ids:
            return []
        return await self._node_repo.get_by_ids(class_ids)

    # ------------------------------------------------------------------
    # Adding / removing classes
    # ------------------------------------------------------------------

    async def add_class(
        self,
        node_id: int,
        class_node_id: int,
        *,
        _system_call: bool = False,
        _page_name_validator: Callable | None = None,
    ) -> bool:
        """Add *class_node_id* to *node_id*.

        Args:
            node_id: Target node.
            class_node_id: Class to add.
            _system_call: When True, bypasses the date-class protection check.
                Used by internal system endpoints (e.g. daily journal creation).
            _page_name_validator: Optional async callable that enforces page-name
                uniqueness. Signature: ``(name, parent_id, classes, exclude_node_id)``
                — raises :class:`DuplicateNodeError` on conflict.

        Returns:
            ``True`` if the class was added, ``False`` if already present / node
            not found.

        Raises:
            SystemClassConstraintError: For protected date classes or block-only
                class / page mismatch violations.
            DuplicateNodeError: If *_page_name_validator* rejects the new class.
        """
        class_node = await self._node_repo.get_by_id(class_node_id)
        if class_node and class_node.uuid in PROTECTED_DATE_CLASS_UUIDS and not _system_call:
            raise SystemClassConstraintError(
                f"Cannot manually add '{class_node.name}' class. "
                "Date classes (day, month, year) are managed by the system."
            )

        node = await self._node_repo.get_by_id(node_id)
        if not node:
            return False

        if class_node and class_node.uuid == CLASS_CLASS_UUID and not node.is_page:
            raise SystemClassConstraintError("The 'class' class can only be assigned to pages, not blocks.")

        if class_node and class_node.uuid in BLOCK_ONLY_CLASS_UUIDS and node.is_page:
            raise SystemClassConstraintError(
                f"The '{class_node.name}' class can only be assigned to blocks, not pages."
            )

        if class_node and class_node.uuid == SYSTEM_CLASS_UUIDS["cloze"]:
            parent_id = node.parent_id
            if parent_id is None:
                raise SystemClassConstraintError(
                    "The 'cloze' class can only be assigned to blocks inside a card."
                )
            parent = await self._node_repo.get_by_id(parent_id)
            if not parent or not parent.is_card:
                raise SystemClassConstraintError(
                    "The 'cloze' class can only be assigned to blocks inside a card."
                )

        current_class_ids = list(node.class_ids or [])
        if class_node_id in current_class_ids:
            return False

        if node.is_page and _page_name_validator:
            new_classes = current_class_ids + [class_node_id]
            await _page_name_validator(
                name=node.name,
                parent_id=node.parent_id,
                classes=new_classes,
                exclude_node_id=node_id,
            )

        new_class_ids = current_class_ids + [class_node_id]
        await self._node_repo.update_node_class_ids(node_id, new_class_ids)
        await self.update_flags_from_classes(node_id, new_class_ids)

        # Apply class-defined property defaults
        await self._apply_class_property_defaults(node_id, class_node_id)
        return True

    async def remove_class(self, node_id: int, class_node_id: int) -> bool:
        """Remove *class_node_id* from *node_id*.

        Raises:
            SystemClassConstraintError: For protected date classes or when
                trying to remove 'class' from a system class node.
        """
        class_node = await self._node_repo.get_by_id(class_node_id)
        if class_node and class_node.uuid in PROTECTED_DATE_CLASS_UUIDS:
            raise SystemClassConstraintError(
                f"Cannot remove '{class_node.name}' class. Date classes (day, month, year) are managed by the system."
            )

        if class_node and class_node.uuid == CLASS_CLASS_UUID:
            node = await self._node_repo.get_by_id(node_id)
            if node and node.uuid in ALL_SYSTEM_CLASS_UUIDS:
                raise SystemClassConstraintError(
                    f"Cannot remove 'class' from system class '{node.name}'. System classes must remain as classes."
                )

        current_class_ids = await self._node_repo.get_node_class_ids(node_id)
        if not current_class_ids:
            return False

        if class_node_id not in current_class_ids:
            return False

        new_class_ids = [cid for cid in current_class_ids if cid != class_node_id]
        await self._node_repo.update_node_class_ids(node_id, new_class_ids)
        await self.update_flags_from_classes(node_id, new_class_ids)

        return True

    # ------------------------------------------------------------------
    # Class extension helpers exposed for collaborators
    # ------------------------------------------------------------------

    async def expand_class_hierarchy(self, class_ids: list[int]) -> set[int]:
        """Expand a list of class IDs to include all subclasses recursively."""
        if self._class_extend_repo is None:
            return set(class_ids)
        return await self._class_extend_repo.expand_class_hierarchy(class_ids)

    async def get_extended_classes_batch(self, node_ids: list[int]) -> dict[int, list[int]]:
        """Get parent class IDs for multiple class nodes."""
        if self._class_extend_repo is None:
            return {}
        return await self._class_extend_repo.get_extended_classes_batch(node_ids)

    def get_class_extension_service(
        self,
        workspace_id: int,
        property_repo: PropertyRepository,
        node_repo: NodeRepository,
    ) -> ClassExtensionService | None:
        """Return a ClassExtensionService backed by this service's extend repo.

        Returns ``None`` when the extend repository is not configured.
        """
        if self._class_extend_repo is None:
            return None
        return ClassExtensionService(
            workspace_id,
            property_repo,
            self._class_extend_repo,
            node_repo,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _apply_class_property_defaults(self, node_id: int, class_node_id: int) -> None:
        """Set default property values declared by *class_node_id* on *node_id*.

        The default source is "edge first, then property": a class-property
        edge declaring its own default wins; otherwise the property's own
        default columns apply.  Skips properties that already have values.
        Logs but does not re-raise individual property failures so that the
        parent add_class call succeeds.
        """
        from app.domain.entities.property import RELATION_TYPES, SCALAR_TYPES, PropertyType

        class_properties = await self._property_repo.get_class_properties(class_node_id)
        for cp in class_properties:
            prop = await self._property_repo.get_by_id(cp.property_id)
            if not prop:
                continue

            existing_values = await self._property_repo.get_all_property_values(node_id)
            if cp.property_id in existing_values and existing_values[cp.property_id].get("values"):
                continue

            try:
                default = default_value_from_columns(cp)
                if default is None:
                    default = default_value_from_columns(prop)
                if default is None:
                    continue

                if prop.type in SCALAR_TYPES:
                    if prop.type in (PropertyType.INTEGER, PropertyType.FLOAT, PropertyType.BOOLEAN):
                        await self._property_repo.set_scalar_value(node_id, cp.property_id, default)

                elif prop.type in RELATION_TYPES:
                    if prop.type == PropertyType.NODE:
                        await self._property_repo.set_relation_value(node_id, cp.property_id, default)
                    elif prop.type == PropertyType.TEXT:
                        text_node = await self._node_repo.create(
                            NodeCreateData(
                                name=serialize_ast(parse_ast(str(default), ParseMode.PLAIN)),
                                parent_id=node_id,
                            ),
                            None,
                        )
                        await self._property_repo.set_relation_value(node_id, cp.property_id, text_node.id)

                elif prop.type == PropertyType.SELECTION:
                    await self._property_repo.set_selection_value(node_id, cp.property_id, default)

            except Exception as exc:
                logger.warning(f"Failed to set default value for property {cp.property_id} on node {node_id}: {exc}")
