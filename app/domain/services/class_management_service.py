"""Class management domain service.

Owns all class-related operations: flag computation, listing, searching,
and adding/removing classes from nodes.  Previously this logic was scattered
across NodeService, the classes router, and the postgres_node repository.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from ...db.schema.constants import SYSTEM_CLASS_UUIDS
from ...logging_config import get_logger
from ..entities import Node, NodeCreateData, NodeUpdateData
from ..errors import SystemClassConstraintError
from ..stringify_ast import ParseMode, parse_ast, serialize_ast

if TYPE_CHECKING:
    import asyncpg

    from ..repositories import NodeRepository, PropertyRepository

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
}

# Full set of system class UUIDs for quick lookup
ALL_SYSTEM_CLASS_UUIDS = set(SYSTEM_CLASS_UUIDS.values())

# UUID of the 'class' class — cannot be stripped from system class nodes
CLASS_CLASS_UUID = SYSTEM_CLASS_UUIDS["class"]

# Maps class UUID → the boolean flag column on the node row
CLASS_UUID_TO_FLAG: dict[str, str] = {
    SYSTEM_CLASS_UUIDS["class"]: "is_class",
    SYSTEM_CLASS_UUIDS["page"]: "is_page",
    SYSTEM_CLASS_UUIDS["day"]: "is_day",
    SYSTEM_CLASS_UUIDS["month"]: "is_month",
    SYSTEM_CLASS_UUIDS["year"]: "is_year",
    SYSTEM_CLASS_UUIDS["asset"]: "is_asset",
    SYSTEM_CLASS_UUIDS["template"]: "is_template",
    SYSTEM_CLASS_UUIDS["comment"]: "is_comment",
}


class ClassManagementService:
    """Domain service that owns all class management operations.

    Responsibilities:
    - Flag computation (CLASS_UUID_TO_FLAG mapping → is_* boolean columns)
    - Listing and searching class nodes
    - Adding and removing classes from nodes (with system constraint checks)
    - Querying which classes a node has
    """

    def __init__(
        self,
        pool: asyncpg.Pool,
        workspace_id: int,
        node_repo: NodeRepository,
        property_repo: PropertyRepository,
    ) -> None:
        self._pool = pool
        self._workspace_id = workspace_id
        self._node_repo = node_repo
        self._property_repo = property_repo

    @property
    def pool(self):
        return self._pool

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
        flags: dict[str, bool] = {}
        if class_ids:
            class_nodes = await self._node_repo.get_by_ids(class_ids)
            for class_node in class_nodes:
                if class_node.uuid in CLASS_UUID_TO_FLAG:
                    flags[CLASS_UUID_TO_FLAG[class_node.uuid]] = True
        return flags

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
        from ..repositories import PostgresPropertyRepository
        from ..repositories.postgres_class_extend import PostgresClassExtendRepository
        from .class_extension_service import ClassExtensionService

        property_repo = PostgresPropertyRepository(self._pool, self._workspace_id, 0)
        class_extend_repo = PostgresClassExtendRepository(self._pool, self._workspace_id, 0)
        extension_service = ClassExtensionService(self._pool, self._workspace_id, property_repo, class_extend_repo)
        subclass_ids = await extension_service.get_all_subclasses(class_id)
        all_class_ids = [class_id] + subclass_ids
        return await self._node_repo.get_nodes_with_classes(all_class_ids, limit=limit, offset=offset)

    async def count_nodes_with_class(self, class_id: int) -> int:
        """Count nodes that carry the given class (or any of its subclasses)."""
        from ..repositories import PostgresPropertyRepository
        from ..repositories.postgres_class_extend import PostgresClassExtendRepository
        from .class_extension_service import ClassExtensionService

        property_repo = PostgresPropertyRepository(self._pool, self._workspace_id, 0)
        class_extend_repo = PostgresClassExtendRepository(self._pool, self._workspace_id, 0)
        extension_service = ClassExtensionService(self._pool, self._workspace_id, property_repo, class_extend_repo)
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
    # Internal helpers
    # ------------------------------------------------------------------

    async def _apply_class_property_defaults(self, node_id: int, class_node_id: int) -> None:
        """Set default property values declared by *class_node_id* on *node_id*.

        Skips properties that already have values.  Logs but does not re-raise
        individual property failures so that the parent add_class call succeeds.
        """
        from ..entities.property import RELATION_TYPES, SCALAR_TYPES, PropertyType

        class_properties = await self._property_repo.get_class_properties(class_node_id)
        for cp in class_properties:
            prop = await self._property_repo.get_by_id(cp.property_id)
            if not prop:
                continue

            existing_values = await self._property_repo.get_all_property_values(node_id)
            if cp.property_id in existing_values and existing_values[cp.property_id].get("values"):
                continue

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
                    if prop.type == PropertyType.NODE and cp.default_node_id is not None:
                        await self._property_repo.set_relation_value(node_id, cp.property_id, cp.default_node_id)
                    elif prop.type == PropertyType.TEXT and cp.default_text is not None:
                        text_node = await self._node_repo.create(
                            NodeCreateData(
                                name=serialize_ast(parse_ast(str(cp.default_text), ParseMode.PLAIN)),
                                parent_id=node_id,
                            ),
                            None,
                        )
                        await self._property_repo.set_relation_value(node_id, cp.property_id, text_node.id)

                elif prop.type == PropertyType.SELECTION and cp.default_selection_id is not None:
                    await self._property_repo.set_selection_value(node_id, cp.property_id, cp.default_selection_id)

            except Exception as exc:
                logger.warning(f"Failed to set default value for property {cp.property_id} on node {node_id}: {exc}")
