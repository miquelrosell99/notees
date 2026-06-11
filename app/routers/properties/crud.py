"""Property CRUD and class filter endpoints."""

from fastapi import APIRouter, Depends, HTTPException

from ...db.connection import acquire_connection
from ...db.schema.constants import SYSTEM_CLASS_UUIDS
from ...domain.entities import RELATION_TYPES, SCALAR_TYPES, Property, PropertyScope, PropertyType
from ...logging_config import get_logger
from ...models import User
from ...utils.datetime_utils import utc_now
from ..auth import get_current_user
from .helpers import _get_property_repo, _property_to_response
from .models import (
    PropertyCreateRequest,
    PropertyTypeChangeRequest,
    PropertyUpdateRequest,
)

logger = get_logger(__name__)

router = APIRouter()


@router.get("/", name="list_properties")
async def list_properties(
    include_local: bool = True,
    user: User = Depends(get_current_user),
):
    """List all property definitions."""
    repo = await _get_property_repo(user)

    properties = await repo.get_all(include_local=include_local)
    logger.info(f"[LIST_PROPERTIES] Returning {len(properties)} properties: {[(p.id, p.name) for p in properties]}")
    return {"properties": [_property_to_response(p) for p in properties]}


@router.get("/local/{node_id}")
async def list_local_properties(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """List all local properties for a specific page node."""
    repo = await _get_property_repo(user)

    properties = await repo.get_local_properties(node_id)
    return {"properties": [_property_to_response(p) for p in properties]}


@router.get("/available")
async def list_available_properties(
    context_node_id: int | None = None,
    context_class_ids: str | None = None,  # comma-separated list of ints
    user: User = Depends(get_current_user),
):
    """List properties available in a given context: global + class-scoped (if context_class_ids) + node-scoped (if context_node_id)."""
    repo = await _get_property_repo(user)

    class_ids: list[int] = []
    if context_class_ids:
        try:
            class_ids = [int(x) for x in context_class_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(400, "context_class_ids must be a comma-separated list of integers") from None

    properties = await repo.get_available_properties(
        context_node_id=context_node_id,
        context_class_ids=class_ids or None,
    )
    return {"properties": [_property_to_response(p) for p in properties]}


@router.get("/stats")
async def get_property_stats(
    user: User = Depends(get_current_user),
):
    """Return usage counts per property across all nodes in this workspace."""
    from ...db.connection import get_pool

    pool = await get_pool()
    repo = await _get_property_repo(user)
    async with acquire_connection(pool) as conn:
        rows = await conn.fetch(
            """
            SELECT np.property_id,
                   COUNT(DISTINCT np.node_id) AS usage_count
            FROM node_property np
            JOIN property p ON np.property_id = p.id
            WHERE p.workspace_id = $1 OR p.workspace_id IS NULL
            GROUP BY np.property_id
        """,
            repo._workspace_id,
        )
    return {"stats": [{"property_id": r["property_id"], "usage_count": r["usage_count"]} for r in rows]}


@router.get("/suggestions")
async def get_property_suggestions(
    node_id: int | None = None,
    user: User = Depends(get_current_user),
):
    """Return property suggestions for a node, ranked by usage frequency."""
    repo = await _get_property_repo(user)
    from ...db.connection import get_pool

    pool = await get_pool()
    async with acquire_connection(pool) as conn:
        # Properties already on the node
        assigned_ids: set[int] = set()
        if node_id:
            rows = await conn.fetch(
                "SELECT property_id FROM node_property WHERE node_id = $1",
                node_id,
            )
            assigned_ids = {r["property_id"] for r in rows}

        # Rank global properties by usage
        rows = await conn.fetch(
            """
            SELECT p.id, p.name, p.icon, p.type,
                   COUNT(DISTINCT np.node_id) AS usage_count
            FROM property p
            LEFT JOIN node_property np ON np.property_id = p.id
            WHERE (p.workspace_id = $1 OR p.workspace_id IS NULL)
              AND p.active = TRUE
              AND p.scope = 'global'
            GROUP BY p.id, p.name, p.icon, p.type
            ORDER BY usage_count DESC, p.name
            LIMIT 20
        """,
            repo._workspace_id,
        )

    suggestions = [
        {
            "property_id": r["id"],
            "name": r["name"],
            "icon": r["icon"],
            "type": r["type"],
            "usage_count": r["usage_count"],
            "already_assigned": r["id"] in assigned_ids,
        }
        for r in rows
    ]
    return {"suggestions": suggestions}


@router.post("/", name="create_property")
async def create_property(
    request: PropertyCreateRequest,
    user: User = Depends(get_current_user),
):
    """Create a new property definition."""
    repo = await _get_property_repo(user)

    # Validate type
    try:
        prop_type = PropertyType(request.type)
    except ValueError:
        raise HTTPException(400, f"Invalid property type: {request.type}") from None

    # Resolve scope
    try:
        scope = PropertyScope(request.scope)
    except ValueError:
        raise HTTPException(400, f"Invalid property scope: {request.scope}") from None

    # Check for duplicate name for global properties
    if scope == PropertyScope.GLOBAL:
        existing = await repo.get_by_name(request.name)
        if existing:
            raise HTTPException(409, f"Property '{request.name}' already exists")

    prop = Property(
        name=request.name,
        icon=request.icon,
        type=prop_type,
        is_multi=request.is_multi,
        scope=scope,
        node_id=request.node_id,
    )

    try:
        created = await repo.create(prop)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    assert created.id is not None, "Created property must have ID"

    # Add class filters for relation-type properties
    if prop_type in RELATION_TYPES:
        # For node-type properties, default to page class if no filters specified
        class_filters = request.class_filters
        if prop_type == PropertyType.NODE and not class_filters:
            # Get the 'page' class ID
            from ...db.connection import acquire_connection, get_pool

            pool = await get_pool()
            async with acquire_connection(pool) as conn:
                page_class_row = await conn.fetchrow(
                    "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2",
                    SYSTEM_CLASS_UUIDS["page"],
                    repo._workspace_id,
                )
                if page_class_row:
                    class_filters = [page_class_row["id"]]

        for class_id in class_filters:
            await repo.add_class_filter(created.id, class_id)

    # Add selection lines for selection-type properties
    if prop_type == PropertyType.SELECTION:
        for line_name in request.selection_lines:
            await repo.add_selection_line(created.id, line_name)

    # Reload to get full data
    reloaded = await repo.get_by_id(created.id)
    if not reloaded:
        raise HTTPException(500, "Failed to reload created property")
    return _property_to_response(reloaded)


@router.get("/{property_id}")
async def get_property(
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Get a property definition by ID."""
    repo = await _get_property_repo(user)

    prop = await repo.get_by_id(property_id)
    if not prop:
        raise HTTPException(404, "Property not found")

    return _property_to_response(prop)


@router.get("/uuid/{uuid}")
async def get_property_by_uuid(
    uuid: str,
    user: User = Depends(get_current_user),
):
    """Get a property definition by UUID."""
    repo = await _get_property_repo(user)

    prop = await repo.get_by_uuid(uuid)
    if not prop:
        raise HTTPException(404, "Property not found")

    return _property_to_response(prop)


@router.put("/{property_id}")
async def update_property(
    property_id: int,
    request: PropertyUpdateRequest,
    user: User = Depends(get_current_user),
):
    """Update a property definition (name, icon, and optionally multi)."""
    repo = await _get_property_repo(user)

    # Check if we're changing multi
    if request.multi is not None:
        prop = await repo.get_by_id(property_id)
        if not prop:
            raise HTTPException(404, "Property not found")

        from ...db.connection import get_pool

        pool = await get_pool()
        async with acquire_connection(pool) as conn:
            # If changing from multi to single, delete extra values
            if prop.is_multi and not request.multi:
                # Delete all values except the first one for each node
                # For scalar values
                if prop.type in SCALAR_TYPES:
                    await conn.execute(
                        """
                        DELETE FROM property_value_scalar
                        WHERE id NOT IN (
                            SELECT MIN(id) FROM property_value_scalar
                            WHERE property_id = $1
                            GROUP BY node_id
                        ) AND property_id = $1
                    """,
                        property_id,
                    )

                # For relation values
                elif prop.type in RELATION_TYPES:
                    await conn.execute(
                        """
                        DELETE FROM property_value_relation
                        WHERE id NOT IN (
                            SELECT MIN(id) FROM property_value_relation
                            WHERE property_id = $1
                            GROUP BY node_id
                        ) AND property_id = $1
                    """,
                        property_id,
                    )

                # For selection values
                elif prop.type == PropertyType.SELECTION:
                    await conn.execute(
                        """
                        DELETE FROM property_value_selection
                        WHERE id NOT IN (
                            SELECT MIN(id) FROM property_value_selection
                            WHERE property_id = $1
                            GROUP BY node_id
                        ) AND property_id = $1
                    """,
                        property_id,
                    )

            # Update the property's is_multi flag (for both single->multi and multi->single)
            await conn.execute(
                "UPDATE property SET is_multi = $1, write_date = $2, write_uid = $3 WHERE id = $4",
                request.multi,
                utc_now(),
                int(user.id),
                property_id,
            )

    # Only call repo.update() if there are name/icon/icon_visibility changes.
    # This avoids the "Cannot modify system properties" error when only
    # the multi flag was changed (already handled above).
    if (
        request.name is not None
        or request.icon is not None
        or request.icon_visibility is not None
        or request.validation_rules is not None
    ):
        if request.validation_rules is not None:
            # Update validation_rules directly since repo.update() doesn't support it yet
            from ...db.connection import get_pool

            pool = await get_pool()

            async with acquire_connection(pool) as conn:
                await conn.execute(
                    "UPDATE property SET validation_rules = $1::jsonb, write_date = $2, write_uid = $3 WHERE id = $4",
                    request.validation_rules,
                    utc_now(),
                    int(user.id),
                    property_id,
                )
        if request.name is not None or request.icon is not None or request.icon_visibility is not None:
            try:
                prop = await repo.update(
                    property_id, name=request.name, icon=request.icon, icon_visibility=request.icon_visibility
                )
            except ValueError as e:
                raise HTTPException(400, str(e)) from e
            if not prop:
                raise HTTPException(404, "Property not found")
        prop = await repo.get_by_id(property_id)
        if not prop:
            raise HTTPException(404, "Property not found")
        return _property_to_response(prop)
    else:
        # Only multi changed (or nothing) — reload and return
        prop = await repo.get_by_id(property_id)
        if not prop:
            raise HTTPException(404, "Property not found")
        return _property_to_response(prop)


@router.post("/{property_id}/change-type")
async def change_property_type(
    property_id: int,
    request: PropertyTypeChangeRequest,
    user: User = Depends(get_current_user),
):
    """Change a property's type (only if no values exist)."""
    repo = await _get_property_repo(user)

    try:
        new_type = PropertyType(request.new_type)
    except ValueError:
        raise HTTPException(400, f"Invalid property type: {request.new_type}") from None

    # Check if can change
    can_change, reason = await repo.can_change_property_type(property_id, new_type)
    if not can_change:
        raise HTTPException(400, reason)

    try:
        prop = await repo.change_property_type(property_id, new_type, request.new_is_multi)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    if not prop:
        raise HTTPException(404, "Property not found")

    return _property_to_response(prop)


@router.get("/{property_id}/can-delete")
async def check_can_delete_property(
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Check if a property can be deleted."""
    repo = await _get_property_repo(user)

    can_delete, reason = await repo.can_delete_property(property_id)
    return {"can_delete": can_delete, "reason": reason}


@router.delete("/{property_id}")
async def delete_property(
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Delete a property definition (only if no values exist)."""
    repo = await _get_property_repo(user)

    try:
        success = await repo.delete(property_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    if not success:
        raise HTTPException(404, "Property not found")

    return {"status": "ok"}


# ============== Class Filters ==============


@router.get("/{property_id}/class-filters")
async def list_class_filters(
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Get all class filters for a property."""
    repo = await _get_property_repo(user)

    filters = await repo.get_class_filters(property_id)
    return {"class_filters": filters}


@router.post("/{property_id}/class-filters")
async def add_class_filter(
    property_id: int,
    class_node_id: int,
    user: User = Depends(get_current_user),
):
    """Add a class filter to a node-type property."""
    repo = await _get_property_repo(user)

    try:
        filter_obj = await repo.add_class_filter(property_id, class_node_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    return {"id": filter_obj.id, "class_node_id": filter_obj.class_node_id}


@router.delete("/{property_id}/class-filters/{class_node_id}")
async def remove_class_filter(
    property_id: int,
    class_node_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a class filter from a property."""
    repo = await _get_property_repo(user)

    success = await repo.remove_class_filter(property_id, class_node_id)
    if not success:
        raise HTTPException(404, "Class filter not found")

    return {"status": "ok"}


# ============== Property Usage Info ==============


@router.get("/{property_id}/nodes")
async def get_nodes_with_property(
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Get all nodes that have this property assigned."""
    from ...db.connection import get_pool
    from ...dependencies import _get_workspace_context_cached
    from ...domain.repositories import PostgresPropertyRepository
    from ..nodes.helpers import extract_properties_dict

    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    repo = PostgresPropertyRepository(pool, workspace_id, user_id)

    # Check property exists
    prop = await repo.get_by_id(property_id)
    if not prop:
        raise HTTPException(404, "Property not found")

    # Get node IDs with this property
    node_ids = await repo.get_node_ids_with_property(property_id)

    # Get class_ids for all nodes in one batch
    from ..nodes.helpers import _get_class_ids_batch

    node_class_map = await _get_class_ids_batch(pool, workspace_id, node_ids)

    # Build response with node details and property values
    result = []
    async with acquire_connection(pool) as conn:
        for node_id in node_ids:
            # Get node details
            node_row = await conn.fetchrow(
                """SELECT id, uuid, name, icon, color, parent_id, page_id, is_page, is_class,
                   create_date, write_date FROM node
                   WHERE id = $1 AND workspace_id = $2 AND active = TRUE""",
                node_id,
                workspace_id,
            )
            if not node_row:
                continue

            # Get all property values for this node
            all_prop_values = await repo.get_all_property_values(node_id)
            properties_dict = extract_properties_dict(all_prop_values)

            # Get class_ids for this node
            class_ids = node_class_map.get(node_id, [])

            result.append(
                {
                    "node_id": node_row["id"],
                    "node_uuid": node_row["uuid"],
                    "node_name": node_row["name"],
                    "node_icon": node_row["icon"],
                    "node_color": node_row["color"],
                    "parent_id": node_row["parent_id"],
                    "page_id": node_row["page_id"],
                    "is_page": bool(node_row["is_page"]),
                    "is_class": bool(node_row["is_class"]),
                    "create_date": node_row["create_date"].isoformat() if node_row["create_date"] else None,
                    "write_date": node_row["write_date"].isoformat() if node_row["write_date"] else None,
                    "properties": properties_dict,
                    "class_ids": class_ids,
                }
            )

    return {"nodes": result, "property": _property_to_response(prop)}
