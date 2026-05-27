"""Class extension/inheritance service.

Handles class extension logic using the class_extend table, including:
- Multi-level inheritance of class properties
- Circular reference detection
- Inherited property resolution with override support

The class_extend table stores inheritance relationships:
- target_id: The child class that extends another class
- source_id: The parent class being extended
- sequence: Order when extending multiple classes
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ...logging_config import get_logger
from ..entities import ClassExtend

if TYPE_CHECKING:
    import asyncpg

    from ..repositories import ClassExtendRepository, PropertyRepository

logger = get_logger(__name__)


@dataclass
class InheritedProperty:
    """Represents a property inherited from an extended class."""

    property_id: int
    property_name: str
    property_type: str
    from_class_id: int
    from_class_name: str
    sequence: int
    default_value: Any
    hidden: bool
    is_overridden: bool = False  # True if the property exists as a dedicated class property


class CircularInheritanceError(Exception):
    """Raised when a circular inheritance is detected."""

    def __init__(self, cycle_path: list[int]):
        self.cycle_path = cycle_path
        super().__init__(f"Circular inheritance detected: {' -> '.join(map(str, cycle_path))}")


class ClassExtensionService:
    """Service for handling class extension/inheritance using class_extend table."""

    def __init__(
        self,
        pool: asyncpg.Pool,
        workspace_id: int,
        property_repository: PropertyRepository,
        class_extend_repository: ClassExtendRepository,
    ):
        self._pool = pool
        self._workspace_id = workspace_id
        self._property_repo = property_repository
        self._class_extend_repo = class_extend_repository

    async def get_extended_classes(self, class_node_id: int) -> list[int]:
        """Get the list of class IDs that this class extends (direct only).

        Returns class IDs in the order they are defined (by sequence).
        """
        return await self._class_extend_repo.get_extended_classes(class_node_id)

    async def get_extended_classes_with_details(self, class_node_id: int) -> list[ClassExtend]:
        """Get the list of classes that this class extends with full details.

        Returns ClassExtend objects with source class name and icon.
        """
        return await self._class_extend_repo.get_extended_classes_with_details(class_node_id)

    async def add_extends(self, class_node_id: int, extends_class_id: int, sequence: int = 0) -> ClassExtend:
        """Add an extends relationship between two classes.

        Args:
            class_node_id: The child class that will extend another
            extends_class_id: The parent class to extend
            sequence: Order when extending multiple classes

        Returns:
            The created ClassExtend relationship

        Raises:
            CircularInheritanceError: If this would create a cycle
            ValueError: If the relationship already exists
        """
        # First validate this won't create a cycle
        await self.validate_extends_acyclic(class_node_id, [extends_class_id])
        return await self._class_extend_repo.add_extends(class_node_id, extends_class_id, sequence)

    async def remove_extends(self, class_node_id: int, extends_class_id: int) -> bool:
        """Remove an extends relationship.

        Returns True if deleted, False if not found.
        """
        return await self._class_extend_repo.remove_extends(class_node_id, extends_class_id)

    async def get_all_extended_classes(self, class_node_id: int, visited: set[int] | None = None) -> list[int]:
        """Get all classes extended by this class (multi-level, depth-first).

        Returns a list of class IDs in the order they should be inherited from.
        Raises CircularInheritanceError if a cycle is detected.

        Inheritance order: [most derived -> least derived]
        Example: C extends B, B extends A -> [C, B, A]
        """
        if visited is None:
            visited = set()

        if class_node_id in visited:
            # Circular reference detected
            raise CircularInheritanceError(list(visited) + [class_node_id])

        visited.add(class_node_id)
        result = [class_node_id]

        # Get direct extensions
        direct_extends = await self.get_extended_classes(class_node_id)

        # Recursively get all extensions for each direct extension
        for extended_class_id in direct_extends:
            try:
                extended_chain = await self.get_all_extended_classes(extended_class_id, visited.copy())
                # Add extended classes (excluding the base class_node_id which is already in result)
                for ext_id in extended_chain:
                    if ext_id not in result:
                        result.append(ext_id)
            except CircularInheritanceError:
                raise

        return result

    async def get_inherited_properties(self, class_node_id: int) -> list[InheritedProperty]:
        """Get all properties inherited from extended classes.

        Properties from more derived classes take precedence.
        Returns properties with is_overridden flag set if they exist as dedicated properties.
        """
        from ..repositories import PostgresNodeRepository

        node_repo = PostgresNodeRepository(self._pool, self._workspace_id, 0)

        try:
            # Get the inheritance chain
            extended_classes = await self.get_all_extended_classes(class_node_id)
        except CircularInheritanceError as e:
            logger.error(f"Circular inheritance detected for class {class_node_id}: {e}")
            return []

        # Remove the class itself from the chain (we only want inherited, not own)
        extended_classes = extended_classes[1:]

        if not extended_classes:
            return []

        # Get dedicated properties for this class
        dedicated_properties = await self._property_repo.get_class_properties(class_node_id)
        dedicated_prop_ids = {cp.property_id for cp in dedicated_properties}

        # Collect properties from all extended classes
        seen_property_ids: set[int] = set()
        inherited_props: list[InheritedProperty] = []

        for extended_class_id in extended_classes:
            class_props = await self._property_repo.get_class_properties(extended_class_id)

            # Get class name
            class_node = await node_repo.get_by_id(extended_class_id)
            class_name = class_node.name if class_node else f"Class {extended_class_id}"

            for cp in class_props:
                # Skip if already seen (more derived class takes precedence)
                if cp.property_id in seen_property_ids:
                    continue

                seen_property_ids.add(cp.property_id)

                # Get property details
                property_details = await self._property_repo.get_by_id(cp.property_id)
                if not property_details:
                    logger.warning(f"Property {cp.property_id} not found")
                    continue

                # Determine default value based on property type
                default_value: Any = None
                if property_details.type == "integer":
                    default_value = cp.default_integer
                elif property_details.type == "float":
                    default_value = cp.default_float
                elif property_details.type in ("text", "url", "email", "phone"):
                    default_value = cp.default_text
                elif property_details.type == "boolean":
                    default_value = cp.default_boolean
                elif property_details.type == "relation":
                    default_value = cp.default_node_id
                elif property_details.type == "selection":
                    default_value = cp.default_selection_id

                inherited_props.append(
                    InheritedProperty(
                        property_id=cp.property_id,
                        property_name=property_details.name,
                        property_type=property_details.type,
                        from_class_id=extended_class_id,
                        from_class_name=class_name,
                        sequence=cp.sequence,
                        default_value=default_value,
                        hidden=cp.hidden,
                        is_overridden=cp.property_id in dedicated_prop_ids,
                    )
                )

        return inherited_props

    async def validate_extends_acyclic(self, class_node_id: int, new_extends_ids: list[int]) -> bool:
        """Validate that adding these extends would not create a cycle.

        Returns True if valid, raises CircularInheritanceError if cycle detected.
        """
        # For each new extend, check if it would create a cycle
        for extend_id in new_extends_ids:
            # Check if extend_id itself extends class_node_id (directly or indirectly)
            try:
                extended_chain = await self.get_all_extended_classes(extend_id)
                if class_node_id in extended_chain:
                    raise CircularInheritanceError([class_node_id, extend_id, class_node_id])
            except CircularInheritanceError:
                raise

        return True

    async def get_classes_extended_by(self, class_node_id: int) -> list[dict[str, Any]]:
        """Get all classes that extend this class (reverse lookup).

        Returns a flat list of classes (not hierarchical).
        """
        return await self._class_extend_repo.get_classes_extended_by(class_node_id)

    async def get_all_subclasses(self, class_node_id: int) -> list[int]:
        """Get all classes that extend this class (recursively).

        Returns all subclasses that directly or indirectly extend this class.
        Example: A <- B <- C means if we query A, we get [B, C]
        """
        result = []
        direct_subclasses = await self._class_extend_repo.get_direct_subclasses(class_node_id)

        # Add direct subclasses
        result.extend(direct_subclasses)

        # Recursively get subclasses of each direct subclass
        for subclass_id in direct_subclasses:
            indirect_subclasses = await self.get_all_subclasses(subclass_id)
            for indirect_id in indirect_subclasses:
                if indirect_id not in result:
                    result.append(indirect_id)

        return result
