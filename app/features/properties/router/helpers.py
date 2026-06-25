"""Helper functions for the Properties API.

Updated for workspace-based schema:
- workspace_id -> workspace_id
- Uses domain entities for response mapping
"""

from app.domain.entities import (
    Property,
    PropertySelectionLine,
    PropertyValueRelation,
    PropertyValueScalar,
    PropertyValueSelection,
)
from app.features.nodes.port import NodeRepository
from app.features.properties.models import (
    PropertyResponse,
    RelationValueResponse,
    ScalarValueResponse,
    SelectionLineResponse,
    SelectionValueResponse,
)
from app.features.properties.port import PropertyRepository


async def _build_node_uuid_map(node_repo: NodeRepository, node_ids: list[int]) -> dict[int, str]:
    """Build a mapping of internal node IDs to public UUIDs."""
    unique_ids = [node_id for node_id in set(node_ids) if node_id is not None]
    if not unique_ids:
        return {}
    nodes = await node_repo.get_by_ids(unique_ids)
    return {node.id: node.uuid for node in nodes if node.id is not None}


async def _build_value_response_maps(
    values: list[PropertyValueScalar | PropertyValueRelation | PropertyValueSelection],
    node_repo: NodeRepository,
    property_repo: PropertyRepository,
) -> tuple[
    dict[int, str],
    dict[int, str],
    dict[int, str],
    dict[int, str],
    dict[int, str],
]:
    """Build lookup maps needed to render property value responses with UUIDs.

    Returns (node_uuid_map, property_uuid_map, node_property_uuid_map,
             target_node_uuid_map, selection_line_uuid_map).
    """
    node_ids: set[int] = set()
    property_ids: set[int] = set()
    node_property_ids: set[int] = set()
    target_node_ids: set[int] = set()
    selection_line_ids: set[int] = set()

    for val in values:
        if val.node_id is not None:
            node_ids.add(val.node_id)
        if val.property_id is not None:
            property_ids.add(val.property_id)
        if val.node_property_id is not None:
            node_property_ids.add(val.node_property_id)
        if isinstance(val, PropertyValueRelation) and val.target_id is not None:
            target_node_ids.add(val.target_id)
        if isinstance(val, PropertyValueSelection) and val.selection_line_id is not None:
            selection_line_ids.add(val.selection_line_id)

    node_uuid_map = await _build_node_uuid_map(node_repo, list(node_ids | target_node_ids))

    property_uuid_map: dict[int, str] = {}
    for pid in property_ids:
        prop = await property_repo.get_by_id(pid)
        if prop is not None and prop.id is not None:
            property_uuid_map[prop.id] = prop.uuid

    node_property_uuid_map: dict[int, str] = {}
    for np_id in node_property_ids:
        np = await property_repo.get_node_property_by_id(np_id)
        if np is not None and np.id is not None:
            node_property_uuid_map[np.id] = np.uuid

    target_node_uuid_map = {nid: uuid for nid, uuid in node_uuid_map.items() if nid in target_node_ids}

    selection_lines = await property_repo.get_selection_lines_by_ids(list(selection_line_ids))
    selection_line_uuid_map = {line.id: line.uuid for line in selection_lines if line.id is not None}

    return (
        node_uuid_map,
        property_uuid_map,
        node_property_uuid_map,
        target_node_uuid_map,
        selection_line_uuid_map,
    )


async def _property_to_response(
    prop: Property,
    node_uuid_map: dict[int, str] | None = None,
    class_uuid_map: dict[int, str] | None = None,
) -> PropertyResponse:
    """Convert domain Property to API response.

    Cross-entity references are emitted as public UUIDs. Callers should supply
    ``node_uuid_map`` and ``class_uuid_map`` when batch-converting properties to
    avoid N+1 lookups; single-property endpoints may omit the maps and the helper
    will fall back to the numeric IDs already present on the entity.
    """
    assert prop.id is not None, "Property must be persisted"
    node_uuid = None
    if prop.node_id is not None and node_uuid_map is not None:
        node_uuid = node_uuid_map.get(prop.node_id)
    # Intentionally leave None if no map is supplied; the field is optional.

    class_filters: list[str] = []
    if prop._class_filters:
        if class_uuid_map is not None:
            class_filters = [class_uuid_map[cid] for cid in prop._class_filters if cid in class_uuid_map]
        else:
            class_filters = [str(cid) for cid in prop._class_filters]

    return PropertyResponse(
        id=prop.id,
        property_uuid=prop.uuid,
        name=prop.name,
        icon=prop.icon,
        type=prop.type.value,
        multi=prop.is_multi,  # Aligned with frontend naming
        is_system=prop.is_system,
        scope=prop.scope.value,
        node_uuid=node_uuid,
        icon_visibility=prop.icon_visibility,
        validation_rules=prop.validation_rules,
        create_date=prop.create_date,
        write_date=prop.write_date,
        class_filters=class_filters,
        options=[  # Aligned with frontend naming
            _selection_line_to_response(line, property_uuid=prop.uuid)
            for line in prop._selection_lines
        ],
    )


def _selection_line_to_response(
    line: PropertySelectionLine,
    property_uuid: str | None = None,
) -> SelectionLineResponse:
    """Convert a selection line entity to API response."""
    assert line.id is not None, "Selection line must be persisted"
    return SelectionLineResponse(
        id=line.id,
        selection_line_uuid=line.uuid,
        property_id=line.property_id,
        property_uuid=property_uuid or "",
        name=line.name,
        icon=line.icon,
        color=line.color,
        order=line.order,
    )


def _scalar_value_to_response(
    val: PropertyValueScalar,
    *,
    node_uuid_map: dict[int, str] | None = None,
    property_uuid_map: dict[int, str] | None = None,
    node_property_uuid_map: dict[int, str] | None = None,
) -> ScalarValueResponse:
    """Convert scalar value to API response."""
    assert val.id is not None, "Value must be persisted"
    return ScalarValueResponse(
        id=val.id,
        scalar_value_uuid=val.uuid,
        node_property_id=val.node_property_id,
        node_property_uuid=node_property_uuid_map.get(val.node_property_id, "")
        if node_property_uuid_map is not None
        else "",
        property_id=val.property_id,
        property_uuid=property_uuid_map.get(val.property_id, "")
        if property_uuid_map is not None
        else "",
        node_id=val.node_id,
        node_uuid=node_uuid_map.get(val.node_id, "")
        if node_uuid_map is not None
        else "",
        value_text=val.value_text,
        value_boolean=val.value_boolean,
        value_float=val.value_float,
        value_integer=val.value_integer,
        order=getattr(val, "order", 0),
    )


def _relation_value_to_response(
    val: PropertyValueRelation,
    *,
    node_uuid_map: dict[int, str] | None = None,
    property_uuid_map: dict[int, str] | None = None,
    node_property_uuid_map: dict[int, str] | None = None,
    target_node_uuid_map: dict[int, str] | None = None,
) -> RelationValueResponse:
    """Convert relation value to API response."""
    assert val.id is not None, "Value must be persisted"
    return RelationValueResponse(
        id=val.id,
        relation_value_uuid=val.uuid,
        node_property_id=val.node_property_id,
        node_property_uuid=node_property_uuid_map.get(val.node_property_id, "")
        if node_property_uuid_map is not None
        else "",
        property_id=val.property_id,
        property_uuid=property_uuid_map.get(val.property_id, "")
        if property_uuid_map is not None
        else "",
        node_id=val.node_id,
        node_uuid=node_uuid_map.get(val.node_id, "")
        if node_uuid_map is not None
        else "",
        target_node_id=val.target_id,
        target_node_uuid=target_node_uuid_map.get(val.target_id, "")
        if target_node_uuid_map is not None
        else "",
        order=getattr(val, "order", 0),
    )


def _selection_value_to_response(
    val: PropertyValueSelection,
    *,
    node_uuid_map: dict[int, str] | None = None,
    property_uuid_map: dict[int, str] | None = None,
    node_property_uuid_map: dict[int, str] | None = None,
    selection_line_uuid_map: dict[int, str] | None = None,
) -> SelectionValueResponse:
    """Convert selection value to API response."""
    assert val.id is not None, "Value must be persisted"
    return SelectionValueResponse(
        id=val.id,
        selection_value_uuid=val.uuid,
        node_property_id=val.node_property_id,
        node_property_uuid=node_property_uuid_map.get(val.node_property_id, "")
        if node_property_uuid_map is not None
        else "",
        property_id=val.property_id,
        property_uuid=property_uuid_map.get(val.property_id, "")
        if property_uuid_map is not None
        else "",
        node_id=val.node_id,
        node_uuid=node_uuid_map.get(val.node_id, "")
        if node_uuid_map is not None
        else "",
        selection_line_id=val.selection_line_id,
        selection_line_uuid=selection_line_uuid_map.get(val.selection_line_id, "")
        if selection_line_uuid_map is not None
        else "",
        order=getattr(val, "order", 0),
    )
