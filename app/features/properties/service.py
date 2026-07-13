"""Property domain service.

Orchestrates property definitions, values, class bindings, and the side
effects (task automation, activity logging) that were previously spread
across the properties routers.
"""

from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING, Any

from app.domain.entities import (
    RELATION_TYPES,
    SCALAR_TYPES,
    Property,
    PropertyClassFilter,
    PropertyScope,
    PropertySelectionLine,
    PropertyType,
)
from app.domain.entities.constants import SYSTEM_PROPERTY_UUIDS
from app.features.properties.attributes import (
    ReadonlyPropertyError,
    RequiredPropertyError,
    is_empty_value,
    resolve_attributes,
)
from app.logging_config import get_logger
from app.utils import utc_now
from app.utils.date_range import normalize_date_range_value

if TYPE_CHECKING:
    from app.features.activity.port import ActivityRepository
    from app.features.nodes.node_service import NodeService
    from app.features.properties.port import PropertyRepository
    from app.features.tasks.service import TaskAutomationService

logger = get_logger(__name__)


class PropertyNotFoundError(LookupError):
    """Raised when a property definition cannot be found."""

    pass


# Sentinel distinguishing "argument not provided" from an explicit None
# (which means "clear the typed default columns").
_UNSET = object()


class PropertyService:
    """Domain service for property lifecycle and value operations."""

    def __init__(
        self,
        workspace_id: int,
        property_repo: PropertyRepository,
        node_service: NodeService,
        task_service: TaskAutomationService | None = None,
        activity_repo: ActivityRepository | None = None,
        user_id: int | None = None,
    ) -> None:
        self._workspace_id = workspace_id
        self._property_repo = property_repo
        self._node_service = node_service
        self._task_service = task_service
        self._activity_repo = activity_repo
        self._user_id = user_id

    @property
    def node_service(self) -> NodeService:
        """Expose the underlying NodeService for callers that need it."""
        return self._node_service

    # ============== Property definition CRUD ==============

    async def list_properties(self, include_local: bool = True) -> list[Property]:
        """List all property definitions."""
        return await self._property_repo.get_all(include_local=include_local)

    async def list_local_properties(self, node_id: int) -> list[Property]:
        """List all local properties for a specific page node."""
        return await self._property_repo.get_local_properties(node_id)

    async def list_available_properties(
        self,
        context_node_id: int | None = None,
        context_class_ids: list[int] | None = None,
    ) -> list[Property]:
        """List properties available in a given context."""
        return await self._property_repo.get_available_properties(
            context_node_id=context_node_id,
            context_class_ids=context_class_ids,
        )

    async def get_property(self, property_id: int) -> Property | None:
        """Get a property definition by ID."""
        return await self._property_repo.get_by_id(property_id)

    async def get_property_by_uuid(self, uuid: str) -> Property | None:
        """Get a property definition by UUID."""
        return await self._property_repo.get_by_uuid(uuid)

    async def create_property(
        self,
        name: str,
        prop_type: PropertyType,
        scope: PropertyScope,
        is_multi: bool = False,
        icon: str | None = None,
        node_id: int | None = None,
        class_filters: list[int] | None = None,
        selection_lines: list[str] | None = None,
    ) -> Property:
        """Create a new property definition.

        Raises:
            ValueError: If a global property with the same name already exists.
        """
        if scope == PropertyScope.GLOBAL:
            existing = await self._property_repo.get_by_name(name)
            if existing:
                raise ValueError(f"Property '{name}' already exists")

        prop = Property(
            name=name,
            icon=icon,
            type=prop_type,
            is_multi=is_multi,
            scope=scope,
            node_id=node_id,
        )

        created = await self._property_repo.create(prop)
        assert created.id is not None, "Created property must have ID"

        if prop_type in RELATION_TYPES:
            filters = list(class_filters or [])
            if prop_type == PropertyType.NODE and not filters:
                page_class_id = await self._property_repo.get_page_class_id()
                if page_class_id:
                    filters = [page_class_id]
            for class_id in filters:
                await self._property_repo.add_class_filter(created.id, class_id)

        if prop_type == PropertyType.SELECTION:
            for line_name in selection_lines or []:
                await self._property_repo.add_selection_line(created.id, line_name)

        reloaded = await self._property_repo.get_by_id(created.id)
        if not reloaded:
            raise RuntimeError("Failed to reload created property")
        return reloaded

    async def update_property(
        self,
        property_id: int,
        name: str | None = None,
        icon: str | None = None,
        icon_visibility: str | None = None,
        is_multi: bool | None = None,
        validation_rules: dict[str, Any] | None = None,
        required: bool | None = None,
        readonly: bool | None = None,
        hide_when_empty: bool | None = None,
        default_value: Any = _UNSET,
    ) -> Property | None:
        """Update a property definition.

        Mirrors the router's multi-flag change handling. `default_value` uses
        the `_UNSET` sentinel: absent = no change, explicit None = clear all
        typed default columns, otherwise the public value (UUIDs for
        selection/relation types) is resolved and mapped to its typed column.
        """
        from app.features.properties.attributes import default_columns_for_value

        prop: Property | None = None
        if is_multi is not None:
            prop = await self._property_repo.get_by_id(property_id)
            if not prop:
                return None

            if prop.is_multi and not is_multi:
                await self._property_repo.delete_excess_property_values(
                    property_id, prop.type
                )

            await self._property_repo.update_property_multi_and_rules(
                property_id,
                is_multi=is_multi,
                validation_rules=validation_rules,
                user_id=int(self._user_id) if self._user_id else 0,
            )
        elif validation_rules is not None:
            await self._property_repo.update_property_multi_and_rules(
                property_id,
                is_multi=None,
                validation_rules=validation_rules,
                user_id=int(self._user_id) if self._user_id else 0,
            )

        clear_defaults = False
        default_columns: dict[str, Any] | None = None
        if default_value is not _UNSET:
            if default_value is None:
                clear_defaults = True
            else:
                if prop is None:
                    prop = await self._property_repo.get_by_id(property_id)
                    if not prop:
                        return None
                resolved = await self._resolve_default_value(prop, default_value)
                default_columns = default_columns_for_value(prop.type, resolved)

        if (
            name is not None
            or icon is not None
            or icon_visibility is not None
            or required is not None
            or readonly is not None
            or hide_when_empty is not None
            or default_value is not _UNSET
        ):
            updated = await self._property_repo.update(
                property_id,
                name=name,
                icon=icon,
                icon_visibility=icon_visibility,
                required=required,
                readonly=readonly,
                hide_when_empty=hide_when_empty,
                clear_defaults=clear_defaults,
                default_columns=default_columns,
            )
            if not updated:
                return None

        return await self._property_repo.get_by_id(property_id)

    async def _resolve_default_value(self, prop: Property, value: Any) -> Any:
        """Resolve public UUIDs in a default value to internal ids where the
        typed default column stores ids (selection lines, node references).

        TEXT defaults are stored verbatim in ``default_text`` (see
        ``attributes._TYPE_DEFAULT_COLUMN``), so their UUIDs round-trip as
        strings instead of being resolved to node ids.
        """
        if prop.type == PropertyType.SELECTION or (
            prop.type in RELATION_TYPES and prop.type != PropertyType.TEXT
        ):
            return await self.resolve_property_value(prop, value)
        return value

    async def change_property_type(
        self,
        property_id: int,
        new_type: PropertyType,
        new_is_multi: bool | None = None,
    ) -> Property | None:
        """Change a property's type (only if no values exist)."""
        can_change, reason = await self._property_repo.can_change_property_type(
            property_id, new_type
        )
        if not can_change:
            raise ValueError(reason)

        return await self._property_repo.change_property_type(
            property_id, new_type, new_is_multi
        )

    async def can_delete_property(self, property_id: int) -> tuple[bool, str | None]:
        """Check if a property can be deleted."""
        can_delete, reason = await self._property_repo.can_delete_property(property_id)
        return can_delete, reason or None

    async def delete_property(self, property_id: int) -> bool:
        """Delete a property definition (only if no values exist)."""
        return await self._property_repo.delete(property_id)

    async def get_property_stats(self) -> list[dict[str, Any]]:
        """Return usage counts per property across the workspace."""
        return await self._property_repo.get_property_stats()

    async def get_property_suggestions(
        self, node_id: int | None = None
    ) -> list[dict[str, Any]]:
        """Return property suggestions for a node, ranked by usage frequency."""
        return await self._property_repo.get_property_suggestions(node_id)

    # ============== Class filters ==============

    async def list_class_filters(self, property_id: int) -> list[PropertyClassFilter]:
        """Get all class filters for a property."""
        return await self._property_repo.get_class_filters(property_id)

    async def add_class_filter(
        self, property_id: int, class_node_id: int
    ) -> PropertyClassFilter:
        """Add a class filter to a node-type property."""
        return await self._property_repo.add_class_filter(property_id, class_node_id)

    async def remove_class_filter(
        self, property_id: int, class_node_id: int
    ) -> bool:
        """Remove a class filter from a property."""
        return await self._property_repo.remove_class_filter(
            property_id, class_node_id
        )

    # ============== Selection lines ==============

    async def list_selection_lines(self, property_id: int) -> list[PropertySelectionLine]:
        """Get all selection lines (options) for a property."""
        return await self._property_repo.get_selection_lines(property_id)

    async def add_selection_line(
        self,
        property_id: int,
        name: str,
        icon: str | None = None,
        color: str | None = None,
        order: int = 0,
    ) -> PropertySelectionLine:
        """Add a selection line (option) to a property."""
        return await self._property_repo.add_selection_line(
            property_id, name, icon, sequence=order, color=color
        )

    async def update_selection_line(
        self,
        line_id: int,
        name: str | None = None,
        icon: str | None = None,
        color: str | None = None,
        order: int | None = None,
    ) -> PropertySelectionLine | None:
        """Update a selection line."""
        return await self._property_repo.update_selection_line(
            line_id, name=name, icon=icon, order=order, color=color
        )

    async def can_delete_selection_line(
        self, line_id: int
    ) -> tuple[bool, str | None]:
        """Check if a selection line can be deleted."""
        can_delete, reason = await self._property_repo.can_delete_selection_line(
            line_id
        )
        return can_delete, reason or None

    async def delete_selection_line(self, line_id: int) -> bool:
        """Delete a selection line (only if not in use)."""
        return await self._property_repo.delete_selection_line(line_id)

    # ============== Node assignment ==============

    async def assign_property_to_node(
        self, node_id: int, property_id: int
    ) -> Any:
        """Assign a property to a node (without setting a value)."""
        return await self._property_repo.assign_property_to_node(node_id, property_id)

    async def remove_property_from_node(
        self,
        node_id: int,
        property_id: int,
        *,
        enforce_attributes: bool = True,
    ) -> bool:
        """Remove a property assignment from a node (including all values).

        When ``enforce_attributes`` is true, the removal is treated as a
        clear of the value: an effectively read-only property rejects it,
        and an effectively required property is reset to its effective
        default (the assignment is kept) or rejected with
        ``RequiredPropertyError`` when no effective default exists.
        """
        if enforce_attributes:
            prop = await self._get_property_or_raise(property_id)
            value = await self._enforce_attributes(node_id, property_id, prop, None)
            if not is_empty_value(value):
                # Required with a default: keep the assignment, reset the value.
                await self.set_property_value(
                    node_id, property_id, value, enforce_attributes=False
                )
                return True
        return await self._property_repo.remove_property_from_node(node_id, property_id)

    async def get_node_properties(
        self, node_id: int
    ) -> dict[int, dict[str, Any]]:
        """Get all property assignments and values for a node."""
        return await self._property_repo.get_all_property_values(node_id)

    async def get_batch_property_values(
        self, node_ids: list[int]
    ) -> dict[int, dict[int, dict[str, Any]]]:
        """Get property values for multiple nodes in one request."""
        return await self._property_repo.get_all_property_values_batch(node_ids)

    # ============== Typed value operations ==============

    async def set_scalar_value(
        self,
        node_id: int,
        property_id: int,
        value: Any,
        order: int = 0,
        *,
        enforce_attributes: bool = True,
    ) -> Any:
        """Set a scalar property value for a node.

        When ``enforce_attributes`` is true, effective attributes are
        enforced (read-only rejects, required empty values reset to the
        effective default or are rejected).
        """
        del order  # Schema no longer stores per-value order.
        if enforce_attributes:
            prop = await self._get_property_or_raise(property_id)
            value = await self._enforce_attributes(node_id, property_id, prop, value)
        return await self._property_repo.set_scalar_value(
            node_id, property_id, value
        )

    async def get_scalar_values(
        self, node_id: int, property_id: int
    ) -> list[Any]:
        """Get all scalar values for a property on a node."""
        return await self._property_repo.get_scalar_values(node_id, property_id)

    async def remove_scalar_value(self, value_id: int) -> bool:
        """Remove a specific scalar value."""
        return await self._property_repo.remove_scalar_value(value_id)

    async def clear_scalar_values(
        self, node_id: int, property_id: int
    ) -> int:
        """Clear all scalar values for a property on a node."""
        return await self._property_repo.clear_scalar_values(node_id, property_id)

    async def set_relation_value(
        self,
        node_id: int,
        property_id: int,
        target_id: int,
        order: int = 0,
        *,
        enforce_attributes: bool = True,
    ) -> Any:
        """Set a relation property value for a node.

        When ``enforce_attributes`` is true, effective attributes are
        enforced (read-only rejects, required empty values reset to the
        effective default or are rejected).
        """
        del order  # Schema no longer stores per-value order.
        if enforce_attributes:
            prop = await self._get_property_or_raise(property_id)
            target_id = await self._enforce_attributes(
                node_id, property_id, prop, target_id
            )
        return await self._property_repo.set_relation_value(
            node_id, property_id, target_id
        )

    async def get_relation_values(
        self, node_id: int, property_id: int
    ) -> list[Any]:
        """Get all relation values for a property on a node."""
        return await self._property_repo.get_relation_values(node_id, property_id)

    async def remove_relation_value(
        self, value_id: int, property_id: int
    ) -> bool:
        """Remove a specific relation value.

        For text/image types, also deletes the target node to avoid floating
        blocks.
        """
        prop = await self._property_repo.get_by_id(property_id)
        delete_target = bool(
            prop and prop.type in (PropertyType.TEXT, PropertyType.IMAGE)
        )
        return await self._property_repo.remove_relation_value(
            value_id, delete_target_node=delete_target
        )

    async def clear_relation_values(
        self, node_id: int, property_id: int
    ) -> int:
        """Clear all relation values for a property on a node.

        For text/image types, also deletes the target nodes to avoid floating
        blocks.
        """
        prop = await self._property_repo.get_by_id(property_id)
        delete_targets = bool(
            prop and prop.type in (PropertyType.TEXT, PropertyType.IMAGE)
        )
        return await self._property_repo.clear_relation_values(
            node_id, property_id, delete_target_nodes=delete_targets
        )

    async def set_selection_value(
        self,
        node_id: int,
        property_id: int,
        selection_line_id: int,
        order: int = 0,
        *,
        enforce_attributes: bool = True,
    ) -> Any:
        """Set a selection property value for a node.

        When ``enforce_attributes`` is true, effective attributes are
        enforced (read-only rejects, required empty values reset to the
        effective default or are rejected).
        """
        del order  # Schema no longer stores per-value order.
        if enforce_attributes:
            prop = await self._get_property_or_raise(property_id)
            selection_line_id = await self._enforce_attributes(
                node_id, property_id, prop, selection_line_id
            )
        return await self._property_repo.set_selection_value(
            node_id, property_id, selection_line_id
        )

    async def get_selection_values(
        self, node_id: int, property_id: int
    ) -> list[Any]:
        """Get all selection values for a property on a node."""
        return await self._property_repo.get_selection_values(node_id, property_id)

    async def remove_selection_value(self, value_id: int) -> bool:
        """Remove a specific selection value."""
        return await self._property_repo.remove_selection_value(value_id)

    async def clear_selection_values(
        self, node_id: int, property_id: int
    ) -> int:
        """Clear all selection values for a property on a node."""
        return await self._property_repo.clear_selection_values(node_id, property_id)

    # ============== High-level value operations ==============

    @staticmethod
    def _normalize_selection_value(value: Any) -> int | None:
        """Extract a single selection line ID from a scalar, list, or empty value."""
        if value is None or value == "":
            return None
        if isinstance(value, list):
            return value[0] if value else None
        return int(value)

    async def _run_task_automations(
        self, node_id: int, prop: Property, value: Any
    ) -> None:
        """Run task lifecycle automations when the task_status property changes."""
        if self._task_service is None:
            return
        if prop.uuid != SYSTEM_PROPERTY_UUIDS["task_status"]:
            return
        status_line_id = self._normalize_selection_value(value)
        try:
            await self._task_service.handle_status_change(node_id, status_line_id)
        except Exception as e:
            logger.warning("[TASK_AUTOMATION] Failed for node %s: %s", node_id, e)

    async def _log_property_change(
        self, node_id: int, prop: Property, property_id: int
    ) -> None:
        """Log a property change activity event."""
        if self._activity_repo is None:
            return
        with contextlib.suppress(ValueError, TypeError, LookupError):
            await self._activity_repo.create_node_activity(
                node_id=node_id,
                action="property_changed",
                details=f"Property '{prop.name}' changed",
                target_node_id=node_id,
                now=utc_now(),
            )

    async def resolve_property_value(self, prop: Property, value: Any) -> Any:
        """Resolve public UUIDs inside a property value to internal IDs.

        Relation-type values may be a single target node UUID or a list of UUIDs.
        Selection-type values may be a single selection line UUID or a list of UUIDs.
        Integer IDs are accepted as a backwards-compatibility fallback.

        Raises:
            PropertyNotFoundError: If a referenced target node or selection line
                cannot be found.
            ValueError: If the value shape is invalid for the property type.
        """
        if value is None or value == "":
            return value

        if prop.type in RELATION_TYPES:
            async def _resolve_relation_item(item: Any) -> int:
                if isinstance(item, int):
                    return item
                if isinstance(item, str):
                    node = await self._node_service.get_node_by_uuid(item)
                    if node is None or node.id is None:
                        raise PropertyNotFoundError(f"Target node {item} not found")
                    return node.id
                raise ValueError(
                    f"Relation property expects node UUID or array of UUIDs, got {type(item)}"
                )

            if isinstance(value, list):
                return [await _resolve_relation_item(item) for item in value]
            return await _resolve_relation_item(value)

        if prop.type == PropertyType.SELECTION:
            async def _resolve_selection_item(item: Any) -> int:
                if isinstance(item, int):
                    return item
                if isinstance(item, str):
                    line = await self._property_repo.get_selection_line_by_uuid(item)
                    if line is None or line.id is None:
                        raise PropertyNotFoundError(f"Selection line {item} not found")
                    return line.id
                raise ValueError(
                    f"Selection property expects selection line UUID or array of UUIDs, got {type(item)}"
                )

            if isinstance(value, list):
                return [await _resolve_selection_item(item) for item in value]
            return await _resolve_selection_item(value)

        return value

    async def _get_property_or_raise(self, property_id: int) -> Property:
        """Fetch a property definition or raise PropertyNotFoundError."""
        prop = await self._property_repo.get_by_id(property_id)
        if prop is None:
            raise PropertyNotFoundError(f"Property {property_id} not found")
        return prop

    async def _enforce_attributes(
        self, node_id: int, property_id: int, prop: Property, value: Any
    ) -> Any:
        """Enforce effective attributes for a value write; return the value to persist.

        Effective attributes are the property bases merged with class-property
        overrides for the node. An empty value written to an effectively
        required property is rewritten to the effective default so callers
        persist (and report) the defaulted value.

        Raises:
            ReadonlyPropertyError: If the property is effectively read-only.
            RequiredPropertyError: If the property is effectively required,
                the value is empty, and no effective default exists.
        """
        edges = await self._property_repo.get_class_property_edges_for_node(
            node_id, property_id
        )
        effective = resolve_attributes(prop, edges)
        if effective.readonly:
            raise ReadonlyPropertyError(
                f"Property '{prop.name}' is read-only for this node"
            )
        if effective.required and is_empty_value(value):
            if effective.default_value is not None:
                return effective.default_value
            raise RequiredPropertyError(
                f"Property '{prop.name}' is required for this node"
            )
        return value

    async def set_property_value_by_uuid(
        self,
        node_id: int,
        property_uuid: str,
        value: Any,
        *,
        run_automations: bool = True,
        log_activity: bool = True,
        enforce_attributes: bool = True,
    ) -> None:
        """Set a property value for a node using the property's public UUID."""
        prop = await self.get_property_by_uuid(property_uuid)
        if prop is None or prop.id is None:
            raise PropertyNotFoundError(f"Property {property_uuid} not found")
        resolved_value = await self.resolve_property_value(prop, value)
        await self.set_property_value(
            node_id,
            prop.id,
            resolved_value,
            run_automations=run_automations,
            log_activity=log_activity,
            enforce_attributes=enforce_attributes,
        )

    async def set_property_value(
        self,
        node_id: int,
        property_id: int,
        value: Any,
        *,
        run_automations: bool = True,
        log_activity: bool = True,
        enforce_attributes: bool = True,
    ) -> None:
        """Set a property value for a node, dispatching by type.

        When ``enforce_attributes`` is true, the effective attributes
        (property bases merged with class-property overrides) are enforced:
        read-only properties reject writes, and clearing a required property
        resets it to its effective default or is rejected.

        Raises:
            PropertyNotFoundError: If the property does not exist.
            ReadonlyPropertyError: If the property is effectively read-only.
            RequiredPropertyError: If a required property is cleared and has
                no effective default to reset to.
            ValueError: If the value is invalid for the property type.
        """
        prop = await self._property_repo.get_by_id(property_id)
        if not prop:
            raise PropertyNotFoundError(f"Property {property_id} not found")

        if enforce_attributes:
            value = await self._enforce_attributes(node_id, property_id, prop, value)

        if prop.type == PropertyType.DATE_RANGE and value is not None and value != "":
            value = normalize_date_range_value(value)

        if prop.type in SCALAR_TYPES:
            logger.info(
                "[SET_PROPERTY] Setting scalar value for node %s, prop %s, value=%r, type=%s",
                node_id,
                property_id,
                value,
                prop.type,
            )
            await self._property_repo.set_scalar_value(node_id, property_id, value)
        elif prop.type in RELATION_TYPES:
            logger.info(
                "[SET_PROPERTY] Setting relation value for node %s, prop %s, value=%r, type=%s",
                node_id,
                property_id,
                value,
                prop.type,
            )
            if value == "" or value is None:
                logger.info(
                    "[SET_PROPERTY] Empty/null value - assigning property without value"
                )
                await self._property_repo.assign_property_to_node(node_id, property_id)
            elif isinstance(value, list):
                unique_values = list(dict.fromkeys(value))
                logger.info(
                    "[SET_PROPERTY] Array of %s unique node IDs (from %s): %s",
                    len(unique_values),
                    len(value),
                    unique_values,
                )
                await self._property_repo.clear_relation_values(node_id, property_id)
                for target_id in unique_values:
                    if not isinstance(target_id, int):
                        raise ValueError(
                            f"Relation property expects node ID, got {type(target_id)} in array"
                        )
                    await self._property_repo.set_relation_value(
                        node_id, property_id, target_id
                    )
            elif isinstance(value, int):
                await self._property_repo.set_relation_value(
                    node_id, property_id, value
                )
            else:
                raise ValueError(
                    f"Relation property expects node ID or array of node IDs, got {type(value)}"
                )
        else:
            logger.info(
                "[SET_PROPERTY] Setting selection value for node %s, prop %s, value=%r, type=%s",
                node_id,
                property_id,
                value,
                prop.type,
            )
            if value == "" or value is None:
                logger.info(
                    "[SET_PROPERTY] Empty/null value - assigning property without value"
                )
                await self._property_repo.assign_property_to_node(node_id, property_id)
            elif isinstance(value, list):
                unique_values = list(dict.fromkeys(value))
                logger.info(
                    "[SET_PROPERTY] Array of %s unique selection IDs (from %s): %s",
                    len(unique_values),
                    len(value),
                    unique_values,
                )
                await self._property_repo.clear_selection_values(node_id, property_id)
                for selection_id in unique_values:
                    if not isinstance(selection_id, int):
                        raise ValueError(
                            f"Selection property expects selection_line_id, got {type(selection_id)} in array"
                        )
                    await self._property_repo.set_selection_value(
                        node_id, property_id, selection_id
                    )
            elif isinstance(value, int):
                await self._property_repo.set_selection_value(
                    node_id, property_id, value
                )
            else:
                raise ValueError(
                    f"Selection property expects selection_line_id or array of IDs, got {type(value)}"
                )

        if run_automations and prop.type not in SCALAR_TYPES and prop.type not in RELATION_TYPES:
            await self._run_task_automations(node_id, prop, value)

        if log_activity:
            await self._log_property_change(node_id, prop, property_id)

    async def batch_set_property_values(
        self,
        items: list[tuple[int, int, Any]],
        *,
        enforce_attributes: bool = True,
    ) -> list[tuple[bool, str | None]]:
        """Set property values for many (node, property, value) tuples.

        Each item is processed independently.  Returns per-item results.

        When ``enforce_attributes`` is true, effective attributes are
        enforced for every item up front, before any value is written:
        read-only violations and un-defaultable required clears raise
        (``ReadonlyPropertyError``/``RequiredPropertyError``), and required
        clears with an effective default are rewritten to the default.
        """
        prop_ids = {item[1] for item in items}
        prop_cache: dict[int, Property | None] = {}
        for pid in prop_ids:
            prop_cache[pid] = await self._property_repo.get_by_id(pid)

        if enforce_attributes:
            enforced_items: list[tuple[int, int, Any]] = []
            for node_id, property_id, value in items:
                prop = prop_cache.get(property_id)
                if prop is not None:
                    value = await self._enforce_attributes(
                        node_id, property_id, prop, value
                    )
                enforced_items.append((node_id, property_id, value))
            items = enforced_items

        results: list[tuple[bool, str | None]] = []
        for node_id, property_id, value in items:
            try:
                prop = prop_cache.get(property_id)
                if not prop:
                    raise ValueError(f"Property {property_id} not found")

                if prop.type == PropertyType.DATE_RANGE and value is not None and value != "":
                    value = normalize_date_range_value(value)

                if prop.type in SCALAR_TYPES:
                    await self._property_repo.set_scalar_value(
                        node_id, property_id, value
                    )
                elif prop.type in RELATION_TYPES:
                    if value == "" or value is None:
                        await self._property_repo.assign_property_to_node(
                            node_id, property_id
                        )
                    elif isinstance(value, list):
                        unique_values = list(dict.fromkeys(value))
                        await self._property_repo.clear_relation_values(
                            node_id, property_id
                        )
                        for target_id in unique_values:
                            await self._property_repo.set_relation_value(
                                node_id, property_id, int(target_id)
                            )
                    elif isinstance(value, int):
                        await self._property_repo.set_relation_value(
                            node_id, property_id, value
                        )
                    else:
                        raise ValueError(
                            f"Relation property expects int or list, got {type(value)}"
                        )
                else:
                    if value == "" or value is None:
                        await self._property_repo.assign_property_to_node(
                            node_id, property_id
                        )
                    elif isinstance(value, list):
                        unique_values = list(dict.fromkeys(value))
                        await self._property_repo.clear_selection_values(
                            node_id, property_id
                        )
                        for sel_id in unique_values:
                            await self._property_repo.set_selection_value(
                                node_id, property_id, int(sel_id)
                            )
                    elif isinstance(value, int):
                        await self._property_repo.set_selection_value(
                            node_id, property_id, value
                        )
                    else:
                        raise ValueError(
                            f"Selection property expects int or list, got {type(value)}"
                        )

                    if (
                        self._task_service
                        and prop.uuid == SYSTEM_PROPERTY_UUIDS["task_status"]
                    ):
                        await self._task_service.handle_status_change(
                            node_id, self._normalize_selection_value(value)
                        )

                results.append((True, None))
            except Exception as e:
                results.append((False, str(e)))

        return results

    # ============== Class-property bindings ==============

    async def get_class_properties(
        self, class_node_id: int, include_inherited: bool = False
    ) -> list[tuple[Any, Property]]:
        """Get properties linked to a class.

        Returns a list of (class_property, property) tuples.
        """
        if include_inherited:
            cps = await self._property_repo.get_all_inherited_properties(class_node_id)
        else:
            cps = await self._property_repo.get_class_properties(class_node_id)

        result: list[tuple[Any, Property]] = []
        for cp in cps:
            prop = await self._property_repo.get_by_id(cp.property_id)
            if not prop:
                continue
            result.append((cp, prop))
        return result

    async def add_class_property(
        self,
        class_node_id: int,
        property_id: int,
        sequence: int = 0,
        default_value: Any = None,
        required: bool | None = None,
        hidden: bool = False,
        readonly: bool | None = None,
        hide_when_empty: bool | None = None,
    ) -> tuple[Any, Property]:
        """Link a property to a class.

        Returns the (class_property, property) pair. Public default values
        (UUIDs for selection/relation types) are resolved to internal ids
        before hitting the repository.

        Raises:
            PropertyNotFoundError: If the property does not exist.
        """
        prop = await self._property_repo.get_by_id(property_id)
        if not prop:
            raise PropertyNotFoundError(f"Property {property_id} not found")

        resolved_default = default_value
        if default_value is not None:
            resolved_default = await self._resolve_default_value(prop, default_value)

        cp = await self._property_repo.add_class_property(
            class_node_id,
            property_id,
            sequence,
            resolved_default,
            required=required,
            hidden=hidden,
            readonly=readonly,
            hide_when_empty=hide_when_empty,
            prop_type=prop.type,
        )
        return cp, prop

    async def batch_add_class_properties(
        self, items: list[tuple[int, int]]
    ) -> list[tuple[bool, str | None]]:
        """Link properties to classes in bulk.

        Duplicates (already bound) are treated as successes.
        """
        results: list[tuple[bool, str | None]] = []
        for class_node_id, property_id in items:
            try:
                await self._property_repo.add_class_property(
                    class_node_id, property_id
                )
                results.append((True, None))
            except ValueError as e:
                msg = str(e)
                if "already" in msg.lower():
                    results.append((True, None))
                else:
                    results.append((False, msg))
            except Exception as e:
                results.append((False, str(e)))
        return results

    async def remove_class_property(
        self, class_node_id: int, property_id: int
    ) -> bool:
        """Remove a property from a class."""
        return await self._property_repo.remove_class_property(
            class_node_id, property_id
        )

    async def update_class_property(
        self,
        class_node_id: int,
        property_id: int,
        updates: dict[str, Any] | None = None,
        default_value: Any = _UNSET,
    ) -> tuple[Any, Property] | None:
        """Update an existing class property binding.

        `updates` holds verbatim column values for the tri-state flags
        (including None = "inherit from property"); callers build it from the
        request's explicitly provided fields. `default_value` uses the
        `_UNSET` sentinel: absent = no change, explicit None = clear all
        typed default columns, otherwise the public value (UUIDs for
        selection/relation types) is resolved and mapped to its typed column.
        """
        from app.features.properties.attributes import default_columns_for_value

        clear_defaults = False
        default_columns: dict[str, Any] | None = None
        if default_value is not _UNSET:
            if default_value is None:
                clear_defaults = True
            else:
                prop = await self._property_repo.get_by_id(property_id)
                if not prop:
                    return None
                resolved = await self._resolve_default_value(prop, default_value)
                default_columns = default_columns_for_value(prop.type, resolved)

        cp = await self._property_repo.update_class_property(
            class_node_id,
            property_id,
            clear_defaults=clear_defaults,
            default_columns=default_columns,
            **(updates or {}),
        )
        if cp is None:
            return None

        prop = await self._property_repo.get_by_id(cp.property_id)
        if not prop:
            return None

        return cp, prop

    async def reorder_class_properties(
        self, class_node_id: int, property_ids: list[int]
    ) -> None:
        """Reorder properties on a class by updating their sequence values."""
        for seq, property_id in enumerate(property_ids):
            await self._property_repo.add_class_property(
                class_node_id, property_id, sequence=seq
            )

    # ============== Usage query ==============

    async def get_nodes_with_property(
        self, property_id: int
    ) -> list[dict[str, Any]]:
        """Get all nodes that have this property assigned.

        Returns a list of dicts with node info, class_ids, and raw property
        values.  Response assembly is left to the router.
        """
        prop = await self._property_repo.get_by_id(property_id)
        if not prop:
            raise PropertyNotFoundError(f"Property {property_id} not found")

        node_ids = await self._property_repo.get_node_ids_with_property(property_id)
        if not node_ids:
            return []

        nodes = await self._node_service.get_nodes_batch(node_ids)
        class_ids_map = await self._node_service.get_class_ids_batch(node_ids)

        result: list[dict[str, Any]] = []
        for node_id in node_ids:
            node = nodes.get(node_id)
            if not node:
                continue

            all_prop_values = await self._property_repo.get_all_property_values(node_id)
            result.append(
                {
                    "node_id": node.id,
                    "node_uuid": node.uuid,
                    "node_name": node.name,
                    "node_icon": node.icon,
                    "node_color": node.color,
                    "parent_id": node.parent_id,
                    "page_id": node.page_id,
                    "is_page": node.is_page,
                    "is_class": node.is_class,
                    "create_date": node.create_date,
                    "write_date": node.write_date,
                    "properties": all_prop_values,
                    "class_ids": class_ids_map.get(node_id, []),
                }
            )

        return result
