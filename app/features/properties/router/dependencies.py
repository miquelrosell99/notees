"""FastAPI dependencies for UUID-aware property routing.

These utilities resolve public UUIDs to internal numeric IDs at the router
boundary, keeping services and repositories numeric-native.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Path

from app.dependencies import get_node_repository, get_property_repository
from app.features.nodes.port import NodeRepository
from app.features.properties.port import PropertyRepository


async def resolve_property_uuid(
    property_uuid: str = Path(..., description="Public property UUID"),
    repo: PropertyRepository = Depends(get_property_repository),
) -> int:
    """Resolve a property UUID to its internal numeric ID."""
    prop = await repo.get_by_uuid(property_uuid)
    if prop is None or prop.id is None:
        raise HTTPException(status_code=404, detail="Property not found")
    return prop.id


async def resolve_property_uuids(
    uuids: list[str],
    repo: PropertyRepository = Depends(get_property_repository),
) -> list[int]:
    """Resolve a list of property UUIDs to internal numeric IDs, preserving order."""
    if not uuids:
        return []
    properties = await repo.get_by_uuids(uuids)
    uuid_to_id = {prop.uuid: prop.id for prop in properties if prop.id is not None}
    missing = [u for u in uuids if u not in uuid_to_id]
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"Properties not found: {missing}",
        )
    return [uuid_to_id[u] for u in uuids]


async def resolve_selection_line_uuid(
    selection_line_uuid: str = Path(..., description="Public selection line UUID"),
    repo: PropertyRepository = Depends(get_property_repository),
) -> int:
    """Resolve a selection line UUID to its internal numeric ID."""
    line = await repo.get_selection_line_by_uuid(selection_line_uuid)
    if line is None or line.id is None:
        raise HTTPException(status_code=404, detail="Selection line not found")
    return line.id


async def resolve_selection_line_uuids(
    uuids: list[str],
    repo: PropertyRepository = Depends(get_property_repository),
) -> list[int]:
    """Resolve a list of selection line UUIDs to internal numeric IDs, preserving order."""
    if not uuids:
        return []
    lines = await repo.get_selection_lines_by_uuids(uuids)
    uuid_to_id = {line.uuid: line.id for line in lines if line.id is not None}
    missing = [u for u in uuids if u not in uuid_to_id]
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"Selection lines not found: {missing}",
        )
    return [uuid_to_id[u] for u in uuids]


async def resolve_node_uuid(
    node_uuid: str = Path(..., description="Public node UUID"),
    repo: NodeRepository = Depends(get_node_repository),
) -> int:
    """Resolve a single node UUID to its internal numeric ID."""
    node = await repo.get_by_uuid(node_uuid)
    if node is None or node.id is None:
        raise HTTPException(status_code=404, detail="Node not found")
    return node.id
