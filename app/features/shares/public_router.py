"""Public API endpoints for anonymous access via share tokens."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from app.dependencies import get_node_repository
from app.features.nodes.port import NodeRepository
from app.features.nodes.router.helpers import _name_text, extract_properties_dict
from app.features.properties.port import PropertyRepository
from app.features.shares.dependencies import (
    _get_public_share_service,
    get_public_property_repository,
    get_share_repository_for_public,
)
from app.features.shares.port import ShareRepository
from app.logging_config import get_logger
from app.utils.password import PasswordVerificationError, verify_password

logger = get_logger(__name__)
router = APIRouter(prefix="/public", tags=["Public"])


def _node_to_public_dict(node, depth: int = 0, display_name: str = "") -> dict:
    """Serialize a node for public access (minimal fields)."""
    return {
        "id": node.id,
        "uuid": node.uuid,
        "name": node.name,
        "display_name": display_name,
        "icon": node.icon,
        "color": node.color,
        "is_page": node.is_page,
        "is_class": node.is_class,
        "is_day": node.is_day,
        "is_month": node.is_month,
        "is_year": node.is_year,
        "is_template": node.is_template,
        "parent_id": node.parent_id,
        "sequence": node.sequence,
        "class_ids": node.class_ids,
        "create_date": node.create_date,
        "write_date": node.write_date,
        "depth": depth,
    }


def _property_to_public_dict(prop) -> dict:
    """Serialize a property definition for public access."""
    return {
        "id": prop.id,
        "uuid": prop.uuid,
        "name": prop.name,
        "icon": prop.icon,
        "type": prop.type.value if hasattr(prop.type, "value") else str(prop.type),
        "multi": prop.is_multi,
        "is_system": prop.is_system,
        "scope": prop.scope.value if hasattr(prop.scope, "value") else str(prop.scope),
        "node_id": prop.node_id,
        "icon_visibility": prop.icon_visibility,
        "validation_rules": prop.validation_rules,
        "create_date": prop.create_date,
        "write_date": prop.write_date,
        "class_filters": list(prop._class_filters) if hasattr(prop, "_class_filters") else [],
        "options": [
            {
                "id": opt.id,
                "name": opt.name,
                "icon": opt.icon,
                "color": opt.color,
                "sequence": opt.sequence,
            }
            for opt in (prop._selection_lines if hasattr(prop, "_selection_lines") else [])
        ],
    }


@router.get("/n/{share_uuid}")
async def get_shared_node(
    share_uuid: str,
    request: Request,
    repo: NodeRepository = Depends(get_node_repository),
    share_repo: ShareRepository = Depends(get_share_repository_for_public),
    prop_repo: PropertyRepository = Depends(get_public_property_repository),
):
    """Get a publicly shared node and its direct children."""
    share = await share_repo.get_share_by_uuid(share_uuid)

    if share is None or not share.is_valid():
        raise HTTPException(status_code=404, detail="Share not found or expired")

    # Check password if set
    if share.password_hash:
        password = request.query_params.get("password") or ""
        try:
            password_ok = bool(password) and verify_password(password, share.password_hash)
        except PasswordVerificationError:
            # Technical fault verifying the share password; do not misreport it
            # as a wrong password.
            raise HTTPException(
                status_code=503,
                detail="This share is temporarily unavailable. Please try again shortly.",
            ) from None
        if not password_ok:
            raise HTTPException(status_code=403, detail="password_required")

    service = await _get_public_share_service(share.workspace_id)
    node = await service.get_shared_node(share_uuid)

    if node is None:
        raise HTTPException(status_code=404, detail="Share not found or expired")

    # Get all non-page descendants (full block hierarchy, excluding child pages)
    rows = await repo.get_shared_node_children(node.id)

    # Resolve display names for nodes that contain inline links
    rows_as_dicts = [{"name": node.name, "uuid": node.uuid}] + [dict(r) for r in rows]
    resolved = await repo.resolve_referenced_display_names(rows_as_dicts)

    node_display_name = resolved.get(node.uuid) or _name_text(node.name, max_len=1000) or "Untitled"

    children = []
    for r in rows:
        uuid_str = str(r["uuid"])
        child_display_name = resolved.get(uuid_str) or _name_text(r["name"], max_len=1000) or "Untitled"
        children.append({
            "id": r["id"],
            "uuid": uuid_str,
            "name": r["name"],
            "display_name": child_display_name,
            "icon": r.get("icon"),
            "color": r.get("color"),
            "is_page": r["is_page"],
            "is_class": r.get("is_class", False),
            "is_day": r.get("is_day", False),
            "is_month": r.get("is_month", False),
            "is_year": r.get("is_year", False),
            "is_template": r.get("is_template", False),
            "parent_id": r["parent_id"],
            "sequence": r["sequence"],
            "class_ids": r.get("class_ids", []),
            "create_date": r["create_date"].isoformat() if r.get("create_date") else None,
            "write_date": r["write_date"].isoformat() if r.get("write_date") else None,
            "depth": r["depth"],
        })

    # Load node properties and definitions for the public share
    raw_properties = await prop_repo.get_all_property_values(node.id)
    properties_dict = extract_properties_dict(raw_properties)

    # Only include property definitions for properties that have values on this node
    active_prop_ids = {int(k) for k in properties_dict}
    all_props = await prop_repo.get_all(include_local=True)
    property_definitions = [
        _property_to_public_dict(p)
        for p in all_props
        if p.id in active_prop_ids
    ]

    return {
        "node": {
            **_node_to_public_dict(node, display_name=node_display_name),
            "properties": properties_dict,
        },
        "children": children,
        "property_definitions": property_definitions,
    }
