"""Batch operations for nodes."""

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi_limiter.depends import RateLimiter as _RateLimiter
from pyrate_limiter import Duration, Limiter, Rate

from app.dependencies import get_current_user, get_link_repository
from app.domain.entities import NodeCreateData, NodeUpdateData
from app.features.nodes.port import LinkRepository
from app.logging_config import get_logger
from app.models import User

from .helpers import (
    _get_class_ids_batch,
    _get_node_service,
    _get_related_ids_batch,
    _node_to_response,
    extract_properties_dict,
)
from .models import (
    BatchGetNodesByUuidRequest,
    BatchGetNodesByUuidResponse,
    BatchGetNodesRequest,
    BatchGetNodesResponse,
    BatchNodeCreateRequest,
    BatchNodeCreateResponse,
    BatchNodeCreateResultItem,
    BatchNodeDeleteRequest,
    BatchNodeDeleteResponse,
    BatchNodeDeleteResultItem,
    BatchNodeUpdateRequest,
    BatchNodeUpdateResponse,
    BatchNodeUpdateResultItem,
    NodeResponse,
)

logger = get_logger(__name__)

_batch_create_limiter = Limiter(Rate(60, Duration.MINUTE))
_batch_update_limiter = Limiter(Rate(120, Duration.MINUTE))
_batch_delete_limiter = Limiter(Rate(120, Duration.MINUTE))
router = APIRouter()


class _SkippableRateLimiter:
    """Wraps fastapi_limiter.RateLimiter with an optional skip predicate."""

    def __init__(
        self,
        limiter: Limiter,
        skip: Callable[[Request], Awaitable[bool]] | None = None,
    ):
        self._impl = _RateLimiter(limiter=limiter)
        self._skip = skip

    async def __call__(self, request: Request, response: Response) -> None:
        if self._skip is not None and await self._skip(request):
            return
        await self._impl(request, response)


async def _skip_bulk_import(request: Request) -> bool:
    """Skip rate limiting for bulk-import requests."""
    return request.headers.get("X-Bulk-Import") == "true"


@router.post(
    "/batch",
    name="batch_create_nodes",
    dependencies=[
        Depends(
            _SkippableRateLimiter(
                limiter=_batch_create_limiter,
                skip=_skip_bulk_import,
            )
        )
    ],
)
async def batch_create_nodes(
    request: Request,
    body: BatchNodeCreateRequest,
    user: User = Depends(get_current_user),
):
    """Create multiple nodes in a single batch.

    Accepts an array of node definitions and creates them sequentially.
    Each node is processed independently — a failure on one node does not
    prevent the others from being created.  Useful for Logseq / bulk imports.
    """
    from app.logging_config import get_logger

    logger = get_logger(__name__)

    service = await _get_node_service(user)

    # Build NodeCreateData list
    create_items = []
    for item in body.nodes:
        create_items.append(
            NodeCreateData(
                name=item.name,
                icon=item.icon,
                color=item.color,
                parent_id=item.parent_id,
                sequence=item.sequence,
                classes=list(item.classes),
                property_values=item.properties,
                uuid=item.uuid,
            )
        )

    raw_results = await service.batch_create_nodes(
        create_items,
        user_id=int(user.id),
        uuid_conflict_mode=body.uuid_conflict_mode,
    )

    results = []
    created = 0
    failed = 0
    existing = 0
    for i, r in enumerate(raw_results):
        if r["success"]:
            if r.get("existing"):
                existing += 1
            else:
                created += 1
            classes = list(body.nodes[i].classes)
            results.append(
                BatchNodeCreateResultItem(
                    index=i,
                    success=True,
                    node=_node_to_response(r["node"], classes=classes),
                    existing=r.get("existing", False),
                )
            )
        else:
            failed += 1
            results.append(
                BatchNodeCreateResultItem(
                    index=i,
                    success=False,
                    error=r["error"],
                )
            )

    logger.info(f"[BATCH_CREATE] {created} created, {existing} existing, {failed} failed out of {len(body.nodes)}")
    return BatchNodeCreateResponse(results=results, created=created, failed=failed)


@router.put(
    "/batch",
    name="batch_update_nodes",
    dependencies=[Depends(_RateLimiter(limiter=_batch_update_limiter))],
)
async def batch_update_nodes(
    request: Request,
    body: BatchNodeUpdateRequest,
    user: User = Depends(get_current_user),
):
    """Update multiple nodes in a single batch.

    Each item identifies the node by `id` or `uuid` (at least one required).
    Failures on one node do not prevent others from being updated.
    Useful for Logseq / bulk imports where many blocks need content updates.
    """
    from app.logging_config import get_logger

    logger = get_logger(__name__)

    service = await _get_node_service(user)

    # Resolve node IDs and build update items
    update_items = []
    resolve_errors = []  # Track items that can't even be resolved

    # Batch-resolve UUIDs to avoid N+1 queries during bulk imports.
    uuid_indices = [
        (i, item) for i, item in enumerate(body.nodes) if item.id is None and item.uuid
    ]
    uuid_to_node: dict[str, Any] = {}
    if uuid_indices:
        uuids = [item.uuid for _, item in uuid_indices if item.uuid]
        uuid_to_node = await service.get_nodes_by_uuids(uuids)

    for i, item in enumerate(body.nodes):
        node_id = item.id

        # If no id provided, try to resolve from uuid
        if node_id is None and item.uuid:
            resolved = uuid_to_node.get(item.uuid)
            if resolved:
                node_id = resolved.id
            else:
                resolve_errors.append((i, f"Node with uuid '{item.uuid}' not found"))
                continue
        elif node_id is None:
            resolve_errors.append((i, "Either 'id' or 'uuid' must be provided"))
            continue

        data = NodeUpdateData(
            name=item.name,
            icon=item.icon,
            color=item.color,
            # In batch mode, we don't clear icon/color unless they were explicitly set.
            # Pydantic defaults them to None which means "unchanged", not "clear".
            clear_icon=False,
            clear_color=False,
            parent_id=item.parent_id,
            sequence=item.sequence,
            collapsed=item.collapsed,
        )

        update_items.append(
            {
                "node_id": node_id,
                "data": data,
                "original_index": i,
                "classes": item.classes,
                "properties": item.properties,
            }
        )

    # Execute batch update via service
    raw_results = await service.batch_update_nodes(update_items, user_id=int(user.id))

    # Build response, interleaving resolve errors and update results
    results = []
    updated = 0
    failed = 0

    # First add resolve errors
    for idx, error in resolve_errors:
        failed += 1
        results.append(
            BatchNodeUpdateResultItem(
                index=idx,
                success=False,
                error=error,
            )
        )

    # Then add update results
    for j, r in enumerate(raw_results):
        original_index = update_items[j]["original_index"]
        if r["success"]:
            node_id = update_items[j]["node_id"]
            item_classes = update_items[j]["classes"]
            item_properties = update_items[j]["properties"]
            # Apply class reconciliation and property values if provided
            if item_classes is not None or item_properties:
                try:
                    await service.apply_node_extras(node_id, item_classes, item_properties)
                except Exception as extras_err:
                    logger.warning(f"[BATCH_UPDATE] extras failed for node {node_id}: {extras_err}")
            updated += 1
            results.append(
                BatchNodeUpdateResultItem(
                    index=original_index,
                    success=True,
                    node=_node_to_response(r["node"]),
                )
            )
        else:
            failed += 1
            results.append(
                BatchNodeUpdateResultItem(
                    index=original_index,
                    success=False,
                    error=r["error"],
                )
            )

    # Sort by original index for consistent ordering
    results.sort(key=lambda r: r.index)

    logger.info(f"[BATCH_UPDATE] {updated} updated, {failed} failed out of {len(body.nodes)}")
    return BatchNodeUpdateResponse(results=results, updated=updated, failed=failed)


@router.delete(
    "/batch",
    name="batch_delete_nodes",
    dependencies=[Depends(_RateLimiter(limiter=_batch_delete_limiter))],
)
async def batch_delete_nodes(
    request: Request,
    body: BatchNodeDeleteRequest,
    user: User = Depends(get_current_user),
):
    """Delete multiple nodes by UUID in a single batch.

    Accepts an array of UUIDs and soft-deletes each node independently.
    A failure on one node does not prevent the others from being deleted.
    """
    from app.logging_config import get_logger

    logger = get_logger(__name__)

    service = await _get_node_service(user)
    raw_results = await service.batch_delete_nodes(body.uuids)

    results = []
    deleted = 0
    failed = 0
    for i, r in enumerate(raw_results):
        if r["success"]:
            deleted += 1
            results.append(
                BatchNodeDeleteResultItem(
                    index=i,
                    uuid=body.uuids[i],
                    success=True,
                )
            )
        else:
            failed += 1
            results.append(
                BatchNodeDeleteResultItem(
                    index=i,
                    uuid=body.uuids[i],
                    success=False,
                    error=r["error"],
                )
            )

    logger.info("Batch delete: %s deleted, %s failed out of %s", deleted, failed, len(body.uuids))
    return BatchNodeDeleteResponse(results=results, deleted=deleted, failed=failed)


@router.post("/batch-get", name="batch_get_nodes")
async def batch_get_nodes(
    request: BatchGetNodesRequest,
    user: User = Depends(get_current_user),
    link_repo: LinkRepository = Depends(get_link_repository),
):
    """Fetch multiple nodes by ID in a single call.

    Returns a dictionary of node_id -> NodeResponse for all found nodes.
    Missing or inaccessible nodes are silently omitted.
    Includes tags, classes, backlink counts, and optionally properties for each node.

    This is much more efficient than making N individual GET requests,
    especially for pages with many inline links or NodePill components.
    """
    service = await _get_node_service(user)

    # Fetch all nodes in a single query
    nodes = await service.get_nodes_by_ids(request.ids)

    if not nodes:
        return BatchGetNodesResponse(nodes={})

    node_ids = [n.id for n in nodes if n.id is not None]

    # Batch-fetch metadata for all nodes in parallel
    class_map = await _get_class_ids_batch(service, node_ids)
    tag_map = await _get_related_ids_batch(service, node_ids, "tags")

    # Batch-fetch backlink counts
    backlink_counts: dict[int, int] = {}
    if node_ids:
        backlink_counts = await link_repo.get_backlink_counts(node_ids)

    # Batch-fetch properties if requested (3 queries total, not N)
    node_properties_map: dict[int, dict[str, any]] = {}
    if request.include_properties and node_ids:
        batch_result = await service.get_nodes_properties_batch(node_ids)
        for nid, prop_data in batch_result.items():
            node_properties_map[nid] = extract_properties_dict(prop_data)

    # Resolve inline links in node names so display_name is usable in tabs,
    # inline pills, and other UI surfaces that don't have their own resolver.
    display_name_map = await service.resolve_node_display_names(nodes)

    # Build response dict
    result: dict[str, NodeResponse] = {}
    for node in nodes:
        if node.id is None:
            continue
        nid = node.id
        response = _node_to_response(
            node,
            tags=tag_map.get(nid, []),
            classes=class_map.get(nid, []),
            backlink_count=backlink_counts.get(nid, 0),
        )
        response.display_name = display_name_map.get(nid) or response.display_name
        if request.include_properties and nid in node_properties_map:
            response.properties = node_properties_map[nid]
        result[str(nid)] = response

    return BatchGetNodesResponse(nodes=result)


@router.post("/batch-get-by-uuid", name="batch_get_nodes_by_uuid")
async def batch_get_nodes_by_uuid(
    request: BatchGetNodesByUuidRequest,
    user: User = Depends(get_current_user),
    link_repo: LinkRepository = Depends(get_link_repository),
):
    """Fetch multiple nodes by UUID in a single call.

    Returns a dictionary of node_uuid -> NodeResponse for all found nodes.
    Missing or inaccessible nodes are silently omitted.
    Includes tags, classes, backlink counts, and optionally properties for each node.

    This is much more efficient than making N individual GET /nodes/uuid/{uuid}
    requests, especially for views that render many inline links at once.
    """
    service = await _get_node_service(user)

    uuid_to_node = await service.get_nodes_by_uuids(request.uuids)
    nodes = list(uuid_to_node.values())

    if not nodes:
        return BatchGetNodesByUuidResponse(nodes={})

    node_ids = [n.id for n in nodes if n.id is not None]

    # Batch-fetch metadata for all nodes in parallel
    class_map = await _get_class_ids_batch(service, node_ids)
    tag_map = await _get_related_ids_batch(service, node_ids, "tags")

    # Batch-fetch backlink counts
    backlink_counts: dict[int, int] = {}
    if node_ids:
        backlink_counts = await link_repo.get_backlink_counts(node_ids)

    # Batch-fetch properties if requested
    node_properties_map: dict[int, dict[str, Any]] = {}
    if request.include_properties and node_ids:
        batch_result = await service.get_nodes_properties_batch(node_ids)
        for nid, prop_data in batch_result.items():
            node_properties_map[nid] = extract_properties_dict(prop_data)

    # Resolve inline links in node names so display_name is usable in tabs,
    # inline pills, and other UI surfaces that don't have their own resolver.
    display_name_map = await service.resolve_node_display_names(nodes)

    # Build response dict keyed by UUID
    result: dict[str, NodeResponse] = {}
    for node in nodes:
        if node.id is None:
            continue
        nid = node.id
        response = _node_to_response(
            node,
            tags=tag_map.get(nid, []),
            classes=class_map.get(nid, []),
            backlink_count=backlink_counts.get(nid, 0),
        )
        response.display_name = display_name_map.get(nid) or response.display_name
        if request.include_properties and nid in node_properties_map:
            response.properties = node_properties_map[nid]
        result[node.uuid] = response

    return BatchGetNodesByUuidResponse(nodes=result)
