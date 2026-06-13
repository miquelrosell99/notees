"""Helper functions for the Properties API.

Updated for workspace-based schema:
- workspace_id -> workspace_id
- Uses _get_workspace_context_cached (respects active workspace)
- Repositories now take user_id for audit trails
"""

from ...dependencies import _get_property_repo as _get_property_repo
from ...domain.entities import (
    Property,
    PropertyValueRelation,
    PropertyValueScalar,
    PropertyValueSelection,
)
from .models import (
    PropertyResponse,
    RelationValueResponse,
    ScalarValueResponse,
    SelectionLineResponse,
    SelectionValueResponse,
)


def _property_to_response(prop: Property) -> PropertyResponse:
    """Convert domain Property to API response."""
    assert prop.id is not None, "Property must be persisted"
    return PropertyResponse(
        id=prop.id,
        uuid=prop.uuid,
        name=prop.name,
        icon=prop.icon,
        type=prop.type.value,
        multi=prop.is_multi,  # Aligned with frontend naming
        is_system=prop.is_system,
        scope=prop.scope.value,
        node_id=prop.node_id,
        icon_visibility=prop.icon_visibility,
        validation_rules=prop.validation_rules,
        create_date=prop.create_date,
        write_date=prop.write_date,
        class_filters=prop._class_filters,
        options=[  # Aligned with frontend naming
            SelectionLineResponse(
                id=line.id,  # type: ignore[arg-type]  # id is always set for persisted lines
                property_id=line.property_id,
                name=line.name,
                icon=line.icon,
                color=line.color,
                order=line.order,
            )
            for line in prop._selection_lines
        ],
    )


def _scalar_value_to_response(val: PropertyValueScalar) -> ScalarValueResponse:
    """Convert scalar value to API response."""
    assert val.id is not None, "Value must be persisted"
    return ScalarValueResponse(
        id=val.id,
        node_property_id=val.node_property_id,
        property_id=val.property_id,
        node_id=val.node_id,
        value_text=val.value_text,
        value_boolean=val.value_boolean,
        value_float=val.value_float,
        value_integer=val.value_integer,
        order=getattr(val, "order", 0),
    )


def _relation_value_to_response(val: PropertyValueRelation) -> RelationValueResponse:
    """Convert relation value to API response."""
    assert val.id is not None, "Value must be persisted"
    return RelationValueResponse(
        id=val.id,
        node_property_id=val.node_property_id,
        property_id=val.property_id,
        node_id=val.node_id,
        target_node_id=val.target_id,
        order=getattr(val, "order", 0),
    )


def _selection_value_to_response(val: PropertyValueSelection) -> SelectionValueResponse:
    """Convert selection value to API response."""
    assert val.id is not None, "Value must be persisted"
    return SelectionValueResponse(
        id=val.id,
        node_property_id=val.node_property_id,
        property_id=val.property_id,
        node_id=val.node_id,
        selection_line_id=val.selection_line_id,
        order=getattr(val, "order", 0),
    )
