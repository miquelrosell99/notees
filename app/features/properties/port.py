"""Repository interface (port) for property operations."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.domain.entities import (
        ClassProperty,
        NodeProperty,
        Property,
        PropertyClassFilter,
        PropertySelectionLine,
        PropertyType,
        PropertyValueRelation,
        PropertyValueScalar,
        PropertyValueSelection,
    )


class PropertyRepository(ABC):
    """Repository interface for Property operations.

    New property system with:
    - property: Property definitions (with local property support)
    - node_property: Assignment of properties to nodes
    - property_value_scalar: Scalar values (integer, float, boolean, date)
    - property_value_relation: Relation values (node, text, image)
    - property_selection_line: Selection options
    - property_value_selection: Selection values
    """

    # ============== Property CRUD ==============

    @abstractmethod
    async def create(self, property: Property) -> Property:
        """Create a new property definition."""
        pass

    @abstractmethod
    async def get_by_id(self, property_id: int) -> Property | None:
        """Get property by ID with type filters and selection lines."""
        pass

    @abstractmethod
    async def get_by_uuid(self, uuid: str) -> Property | None:
        """Get property by UUID."""
        pass

    @abstractmethod
    async def get_by_uuids(self, uuids: list[str]) -> list[Property]:
        """Get multiple properties by UUID in a single query, preserving order."""
        pass

    @abstractmethod
    async def get_by_name(self, name: str, node_id: int | None = None) -> Property | None:
        """Get property by name. For local properties, node_id specifies the page context."""
        pass

    @abstractmethod
    async def get_all(self, include_local: bool = True) -> list[Property]:
        """Get all property definitions."""
        pass

    @abstractmethod
    async def get_local_properties(self, node_id: int) -> list[Property]:
        """Get all local properties for a specific page node."""
        pass

    @abstractmethod
    async def update(self, property_id: int, name: str | None = None, icon: str | None = None) -> Property | None:
        """Update a property definition (name and icon only)."""
        pass

    @abstractmethod
    async def can_delete_property(self, property_id: int) -> tuple[bool, str]:
        """Check if a property can be deleted."""
        pass

    @abstractmethod
    async def can_change_property_type(self, property_id: int, new_type: PropertyType) -> tuple[bool, str]:
        """Check if a property type can be changed."""
        pass

    @abstractmethod
    async def change_property_type(
        self, property_id: int, new_type: PropertyType, new_is_multi: bool | None = None
    ) -> Property | None:
        """Change a property's type if no values exist."""
        pass

    @abstractmethod
    async def delete(self, property_id: int) -> bool:
        """Delete a property if no values exist."""
        pass

    # ============== Node Property (Assignment) ==============

    @abstractmethod
    async def assign_property_to_node(self, node_id: int, property_id: int) -> NodeProperty:
        """Assign a property to a node (without setting a value)."""
        pass

    @abstractmethod
    async def get_node_property(self, node_id: int, property_id: int) -> NodeProperty | None:
        """Get a node_property assignment."""
        pass

    @abstractmethod
    async def get_node_property_by_id(self, node_property_id: int) -> NodeProperty | None:
        """Get a node_property assignment by its internal ID."""
        pass

    @abstractmethod
    async def get_node_properties(self, node_id: int) -> list[NodeProperty]:
        """Get all property assignments for a node."""
        pass

    @abstractmethod
    async def remove_property_from_node(self, node_id: int, property_id: int) -> bool:
        """Remove a property assignment from a node."""
        pass

    @abstractmethod
    async def get_node_ids_with_property(self, property_id: int) -> list[int]:
        """Get all node IDs that have a specific property assigned."""
        pass

    # ============== Scalar Values ==============

    @abstractmethod
    async def set_scalar_value(self, node_id: int, property_id: int, value: Any) -> PropertyValueScalar:
        """Set a scalar property value for a node."""
        pass

    @abstractmethod
    async def get_scalar_values(self, node_id: int, property_id: int) -> list[PropertyValueScalar]:
        """Get all scalar values for a property on a node."""
        pass

    @abstractmethod
    async def get_scalar_value_by_uuid(self, value_uuid: str) -> PropertyValueScalar | None:
        """Get a specific scalar value by its public UUID."""
        pass

    @abstractmethod
    async def remove_scalar_value(self, value_id: int) -> bool:
        """Remove a specific scalar value."""
        pass

    @abstractmethod
    async def clear_scalar_values(self, node_id: int, property_id: int) -> int:
        """Remove all scalar values for a property on a node."""
        pass

    # ============== Relation Values ==============

    @abstractmethod
    async def set_relation_value(self, node_id: int, property_id: int, target_id: int) -> PropertyValueRelation:
        """Set a relation property value for a node."""
        pass

    @abstractmethod
    async def get_relation_values(self, node_id: int, property_id: int) -> list[PropertyValueRelation]:
        """Get all relation values for a property on a node."""
        pass

    @abstractmethod
    async def get_relation_value_by_uuid(self, value_uuid: str) -> PropertyValueRelation | None:
        """Get a specific relation value by its public UUID."""
        pass

    @abstractmethod
    async def remove_relation_value(self, value_id: int, delete_target_node: bool = False) -> bool:
        """Remove a specific relation value.

        Args:
            value_id: The ID of the property_value_relation to delete
            delete_target_node: If True, also delete the target node (for text/image types)
        """
        pass

    @abstractmethod
    async def clear_relation_values(self, node_id: int, property_id: int, delete_target_nodes: bool = False) -> int:
        """Remove all relation values for a node on a property.

        Args:
            node_id: The node to clear values from
            property_id: The property to clear values for
            delete_target_nodes: If True and property is text/image type, also delete target nodes
        """
        pass

    @abstractmethod
    async def delete_relation_values_by_target(self, target_id: int) -> int:
        """Delete all property_value_relation rows where target_id matches.

        Used when a node is deleted to clean up node-type property references.
        """
        pass

    # ============== Selection Lines (Options) ==============

    @abstractmethod
    async def add_selection_line(
        self, property_id: int, name: str, icon: str | None = None, sequence: int = 0
    ) -> PropertySelectionLine:
        """Add an option to a selection-type property."""
        pass

    @abstractmethod
    async def get_selection_lines(self, property_id: int) -> list[PropertySelectionLine]:
        """Get all selection options for a property."""
        pass

    @abstractmethod
    async def get_selection_line_by_uuid(self, uuid: str) -> PropertySelectionLine | None:
        """Get a selection option by its public UUID."""
        pass

    @abstractmethod
    async def get_selection_lines_by_ids(self, ids: list[int]) -> list[PropertySelectionLine]:
        """Get multiple selection options by internal ID in a single query."""
        pass

    @abstractmethod
    async def get_selection_lines_by_uuids(self, uuids: list[str]) -> list[PropertySelectionLine]:
        """Get multiple selection options by public UUID in a single query, preserving order."""
        pass

    @abstractmethod
    async def update_selection_line(
        self, line_id: int, name: str | None = None, icon: str | None = None, order: int | None = None
    ) -> PropertySelectionLine | None:
        """Update a selection option."""
        pass

    @abstractmethod
    async def can_delete_selection_line(self, line_id: int) -> tuple[bool, str]:
        """Check if a selection line can be deleted."""
        pass

    @abstractmethod
    async def delete_selection_line(self, line_id: int) -> bool:
        """Delete a selection option if not in use."""
        pass

    # ============== Selection Values ==============

    @abstractmethod
    async def set_selection_value(
        self, node_id: int, property_id: int, selection_line_id: int
    ) -> PropertyValueSelection:
        """Set a selection property value for a node."""
        pass

    @abstractmethod
    async def get_selection_values(self, node_id: int, property_id: int) -> list[PropertyValueSelection]:
        """Get all selection values for a property on a node."""
        pass

    @abstractmethod
    async def get_selection_value_by_uuid(self, value_uuid: str) -> PropertyValueSelection | None:
        """Get a specific selection value by its public UUID."""
        pass

    @abstractmethod
    async def remove_selection_value(self, value_id: int) -> bool:
        """Remove a specific selection value."""
        pass

    @abstractmethod
    async def clear_selection_values(self, node_id: int, property_id: int) -> int:
        """Remove all selection values for a property on a node."""
        pass

    # ============== Class Filters ==============

    @abstractmethod
    async def add_class_filter(self, property_id: int, class_node_id: int) -> PropertyClassFilter:
        """Add a class filter to a relation-type property."""
        pass

    @abstractmethod
    async def get_class_filters(self, property_id: int) -> list[PropertyClassFilter]:
        """Get all class filters for a property."""
        pass

    @abstractmethod
    async def get_class_filter_by_uuid(self, uuid: str) -> PropertyClassFilter | None:
        """Get a class filter by its public UUID."""
        pass

    @abstractmethod
    async def remove_class_filter(self, property_id: int, class_node_id: int) -> bool:
        """Remove a class filter from a property."""
        pass

    # ============== Unified Value Access ==============

    @abstractmethod
    async def get_all_property_values(self, node_id: int) -> dict[int, dict[str, Any]]:
        """Get all property values for a node, grouped by property_id."""
        pass

    @abstractmethod
    async def get_all_property_values_batch(self, node_ids: list[int]) -> dict[int, dict[int, dict[str, Any]]]:
        """Get all property values for multiple nodes at once.

        Returns: {node_id -> {property_id -> {'property': ..., 'node_property': ..., 'values': [...]}}}
        """
        pass

    @abstractmethod
    async def get_text_property_target_ids(self, target_ids: list[int]) -> set[int]:
        """Get IDs of nodes that are text-property value blocks for the given targets."""
        pass

    @abstractmethod
    async def get_text_property_contexts_for_targets(
        self, target_ids: list[int]
    ) -> dict[int, list[dict[str, Any]]]:
        """For each target node ID, return the text-property relations that reference it.

        Returns a mapping of target_id -> list of dicts with keys:
        property_id, property_name, property_icon, node_id.
        """
        pass

    @abstractmethod
    async def clear_all_property_values(self, node_id: int, property_id: int) -> None:
        """Clear all values for a property on a node (but keep the assignment)."""
        pass

    # ============== Class Properties ==============

    @abstractmethod
    async def get_class_properties(self, class_node_id: int) -> list[ClassProperty]:
        """Get properties that a class applies to classed nodes."""
        pass

    @abstractmethod
    async def get_class_property_by_uuid(self, uuid: str) -> ClassProperty | None:
        """Get a class property binding by its public UUID."""
        pass

    @abstractmethod
    async def add_class_property(
        self, class_node_id: int, property_id: int, sequence: int = 0, default_value: Any = None, required: bool = False
    ) -> ClassProperty:
        """Link a property to a class."""
        pass

    @abstractmethod
    async def remove_class_property(self, class_node_id: int, property_id: int) -> bool:
        """Remove a property from a class."""
        pass

    @abstractmethod
    async def update_class_property(
        self,
        class_node_id: int,
        property_id: int,
        required: bool | None = None,
        hidden: bool | None = None,
    ) -> ClassProperty | None:
        """Update an existing class property (required, hidden flags)."""
        pass

    @abstractmethod
    async def get_all_inherited_properties(self, class_node_id: int) -> list[ClassProperty]:
        """Get all properties for a class including inherited ones."""
        pass

    @abstractmethod
    async def get_property_stats(self) -> list[dict[str, Any]]:
        """Return usage counts per property across all nodes in this workspace."""
        pass

    @abstractmethod
    async def get_property_suggestions(self, node_id: int | None) -> list[dict[str, Any]]:
        """Return property suggestions for a node, ranked by usage frequency."""
        pass

    @abstractmethod
    async def get_page_class_id(self) -> int | None:
        """Return the integer ID of the page class in this workspace."""
        pass

    @abstractmethod
    async def update_property_multi_and_rules(
        self,
        property_id: int,
        is_multi: bool | None,
        validation_rules: dict[str, Any] | None,
        user_id: int,
    ) -> None:
        """Update property is_multi and/or validation_rules."""
        pass

    @abstractmethod
    async def delete_excess_property_values(self, property_id: int, prop_type: PropertyType) -> None:
        """Delete all but the first value per node when switching from multi to single."""
        pass
