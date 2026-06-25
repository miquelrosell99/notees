"""FastAPI dependencies for UUID-aware node routing.

These utilities resolve public node UUIDs to internal numeric IDs at the
router boundary, keeping services and repositories numeric-native.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Path

from app.dependencies import get_node_repository, get_node_view_repository, get_property_repository
from app.features.nodes.port import NodeRepository, NodeViewRepository
from app.features.properties.port import PropertyRepository


async def resolve_node_uuid(
    node_uuid: str = Path(..., description="Public node UUID"),
    repo: NodeRepository = Depends(get_node_repository),
) -> int:
    """Resolve a single node UUID to its internal numeric ID."""
    node = await repo.get_by_uuid(node_uuid)
    if node is None or node.id is None:
        raise HTTPException(status_code=404, detail="Node not found")
    return node.id


async def resolve_class_uuid(
    class_uuid: str = Path(..., description="Public class node UUID"),
    repo: NodeRepository = Depends(get_node_repository),
) -> int:
    """Resolve a class node UUID to its internal numeric ID."""
    node = await repo.get_by_uuid(class_uuid)
    if node is None or node.id is None:
        raise HTTPException(status_code=404, detail="Class not found")
    return node.id


async def resolve_target_uuid(
    target_uuid: str = Path(..., description="Public target node UUID"),
    repo: NodeRepository = Depends(get_node_repository),
) -> int:
    """Resolve a target node UUID to its internal numeric ID."""
    node = await repo.get_by_uuid(target_uuid)
    if node is None or node.id is None:
        raise HTTPException(status_code=404, detail="Target node not found")
    return node.id


async def resolve_alias_uuid(
    alias_uuid: str = Path(..., description="Public alias node UUID"),
    repo: NodeRepository = Depends(get_node_repository),
) -> int:
    """Resolve an alias node UUID to its internal numeric ID."""
    node = await repo.get_by_uuid(alias_uuid)
    if node is None or node.id is None:
        raise HTTPException(status_code=404, detail="Alias node not found")
    return node.id


async def resolve_comment_uuid(
    comment_uuid: str = Path(..., description="Public comment node UUID"),
    repo: NodeRepository = Depends(get_node_repository),
) -> int:
    """Resolve a comment node UUID to its internal numeric ID."""
    node = await repo.get_by_uuid(comment_uuid)
    if node is None or node.id is None:
        raise HTTPException(status_code=404, detail="Comment not found")
    return node.id


async def resolve_property_uuid(
    property_uuid: str = Path(..., description="Public property UUID"),
    repo: PropertyRepository = Depends(get_property_repository),
) -> int:
    """Resolve a property UUID to its internal numeric ID."""
    prop = await repo.get_by_uuid(property_uuid)
    if prop is None or prop.id is None:
        raise HTTPException(status_code=404, detail="Property not found")
    return prop.id


async def resolve_view_uuid(
    view_uuid: str = Path(..., description="Public node view UUID"),
    repo: NodeViewRepository = Depends(get_node_view_repository),
) -> int:
    """Resolve a NodeView UUID to its internal numeric ID."""
    view = await repo.get_by_uuid(view_uuid)
    if view is None or view.id is None:
        raise HTTPException(status_code=404, detail="NodeView not found")
    return view.id


async def resolve_node_uuids(
    uuids: list[str],
    repo: NodeRepository = Depends(get_node_repository),
) -> list[int]:
    """Resolve a list of node UUIDs to internal numeric IDs, preserving order."""
    if not uuids:
        return []
    nodes = await repo.get_by_uuids(uuids)
    uuid_to_id = {node.uuid: node.id for node in nodes if node.id is not None}
    missing = [u for u in uuids if u not in uuid_to_id]
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"Nodes not found: {missing}",
        )
    return [uuid_to_id[u] for u in uuids]


async def resolve_class_uuids(
    uuids: list[str],
    repo: NodeRepository = Depends(get_node_repository),
) -> list[int]:
    """Resolve a list of class node UUIDs to internal numeric IDs, preserving order."""
    if not uuids:
        return []
    nodes = await repo.get_by_uuids(uuids)
    uuid_to_id = {node.uuid: node.id for node in nodes if node.id is not None}
    missing = [u for u in uuids if u not in uuid_to_id]
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"Classes not found: {missing}",
        )
    return [uuid_to_id[u] for u in uuids]


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


async def resolve_view_uuids(
    uuids: list[str],
    repo: NodeViewRepository = Depends(get_node_view_repository),
) -> list[int]:
    """Resolve a list of NodeView UUIDs to internal numeric IDs, preserving order."""
    if not uuids:
        return []
    views = await repo.get_by_uuids(uuids)
    uuid_to_id = {view.uuid: view.id for view in views if view.id is not None}
    missing = [u for u in uuids if u not in uuid_to_id]
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"NodeViews not found: {missing}",
        )
    return [uuid_to_id[u] for u in uuids]
