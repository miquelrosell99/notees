"""Helper functions for the Properties API.

Updated for graph-based schema:
- workspace_id -> graph_id
- Uses get_or_create_user_graph
- Repositories now take user_id for audit trails
"""
from typing import cast
import asyncpg

from ...domain.entities import (
    Property, PropertyValueScalar, PropertyValueRelation, PropertyValueSelection,
)
from ...domain.repositories import PostgresPropertyRepository
from ...db.connection import get_pool
from ...db.schema import get_or_create_user_graph
from ...models import User
from .models import (
    PropertyResponse,
    SelectionLineResponse,
    ScalarValueResponse,
    RelationValueResponse,
    SelectionValueResponse,
)


async def _get_property_repo(user: User) -> PostgresPropertyRepository:
    """Get PropertyRepository for user's graph."""
    pool = await get_pool()
    user_id = int(user.id)
    async with pool.acquire() as conn:
        graph_id = await get_or_create_user_graph(cast(asyncpg.Connection, conn), user_id)
    return PostgresPropertyRepository(pool, graph_id, user_id)


def _property_to_response(prop: Property) -> PropertyResponse:
    """Convert domain Property to API response."""
    assert prop.id is not None, "Property must be persisted"
    return PropertyResponse(
        id=prop.id,
        uuid=prop.uuid,
        name=prop.name,
        icon=prop.icon,
        type=prop.type.value,
        is_multi=prop.is_multi,
        is_system=prop.is_system,
        is_local=prop.is_local,
        node_id=prop.node_id,
        create_date=prop.create_date,
        write_date=prop.write_date,
        class_filters=prop._class_filters,
        selection_lines=[
            SelectionLineResponse(
                id=l.id,  # type: ignore[arg-type]  # id is always set for persisted lines
                property_id=l.property_id,
                name=l.name,
                icon=l.icon,
                order=l.order,
            )
            for l in prop._selection_lines
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
        order=val.order,
    )


def _relation_value_to_response(val: PropertyValueRelation) -> RelationValueResponse:
    """Convert relation value to API response."""
    assert val.id is not None, "Value must be persisted"
    return RelationValueResponse(
        id=val.id,
        node_property_id=val.node_property_id,
        property_id=val.property_id,
        node_id=val.node_id,
        target_node_id=val.target_node_id,
        order=val.order,
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
        order=val.order,
    )
