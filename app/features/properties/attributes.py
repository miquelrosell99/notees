"""Property attribute resolution: property-level bases with class-edge overrides.

Attributes (required, readonly, hide_when_empty, default) are defined on the
property itself. Each class_property edge may override them tri-state
(NULL = inherit). Resolution walks edges ordered nearest-class-first; the
first non-NULL override wins, otherwise the property base applies.
"""

from dataclasses import dataclass
from typing import Any

from app.domain.entities.property import ClassProperty, Property, PropertyType

DEFAULT_COLUMNS = (
    "default_integer",
    "default_float",
    "default_text",
    "default_boolean",
    "default_node_id",
    "default_selection_id",
)

# Maps each property type to the typed default column holding its default value.
# URL/EMAIL are plain strings -> default_text. NODE/IMAGE/DATE are node
# references -> default_node_id. DATE_RANGE is structured JSON with no fitting
# typed column, so it is intentionally unmapped (no default column support).
_TYPE_DEFAULT_COLUMN: dict[PropertyType, str] = {
    PropertyType.INTEGER: "default_integer",
    PropertyType.FLOAT: "default_float",
    PropertyType.BOOLEAN: "default_boolean",
    PropertyType.TEXT: "default_text",
    PropertyType.URL: "default_text",
    PropertyType.EMAIL: "default_text",
    PropertyType.NODE: "default_node_id",
    PropertyType.IMAGE: "default_node_id",
    PropertyType.DATE: "default_node_id",
    PropertyType.SELECTION: "default_selection_id",
}


class RequiredPropertyError(ValueError):
    code = "required_property"


class ReadonlyPropertyError(ValueError):
    code = "readonly_property"


@dataclass(frozen=True)
class EffectiveAttributes:
    required: bool
    readonly: bool
    hide_when_empty: bool
    default_value: Any | None


def is_empty_value(value: Any) -> bool:
    return value is None or value == "" or value == []


def default_value_from_columns(obj: Any, prop_type: PropertyType) -> Any | None:
    """Typed default column for the given property type (False/0 are valid defaults).

    Only the column mapped for the type is read: values in other typed
    columns are cross-type leftovers and must not resolve as defaults. Types
    without a mapped column (DATE_RANGE) have no default column support and
    always return None.
    """
    column = _TYPE_DEFAULT_COLUMN.get(prop_type)
    if column is None:
        return None
    return getattr(obj, column, None)


def default_columns_for_value(prop_type: PropertyType, value: Any) -> dict[str, Any]:
    """Map a public default value to its typed column; empty -> no columns."""
    if is_empty_value(value):
        return {}
    column = _TYPE_DEFAULT_COLUMN.get(prop_type)
    if column is None:
        return {}
    return {column: value}


def _resolve_flag(base: bool, edges: list[ClassProperty], attr: str) -> bool:
    for edge in edges:
        override = getattr(edge, attr, None)
        if override is not None:
            return override
    return base


def resolve_attributes(prop: Property, edges: list[ClassProperty]) -> EffectiveAttributes:
    """Resolve effective attributes for a node+property.

    `edges` must be ordered nearest-class-first (see
    PropertyRepository.get_class_property_edges_for_node).
    """
    default: Any | None = None
    for edge in edges:
        default = default_value_from_columns(edge, prop.type)
        if default is not None:
            break
    if default is None:
        default = default_value_from_columns(prop, prop.type)
    return EffectiveAttributes(
        required=_resolve_flag(prop.required, edges, "required"),
        readonly=_resolve_flag(prop.readonly, edges, "readonly"),
        hide_when_empty=_resolve_flag(prop.hide_when_empty, edges, "hide_when_empty"),
        default_value=default,
    )
