"""Version history operations for nodes."""
from typing import Optional, List, Dict

from fastapi import APIRouter, HTTPException, Depends, Path, Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from ...logging_config import get_logger
logger = get_logger(__name__)

from ...domain.entities import NodeCreateData, NodeUpdateData
from ...domain.errors import DatePageDeletionError, OptimisticLockError, DuplicateNodeError, SystemClassConstraintError
from ..auth import get_current_user
from ...models import User
from .models import (
    NodeResponse,
    NodeCreateRequest,
    NodeUpdateRequest,
    BatchNodeCreateRequest,
    BatchNodeCreateResponse,
    BatchNodeCreateResultItem,
    BatchNodeUpdateRequest,
    BatchNodeUpdateResponse,
    BatchNodeUpdateResultItem,
    BatchNodeDeleteRequest,
    BatchNodeDeleteResponse,
    BatchNodeDeleteResultItem,
    BatchPermanentDeleteRequest,
    BatchPermanentDeleteResponse,
    BatchPermanentDeleteResultItem,
    BatchGetNodesRequest,
    BatchGetNodesResponse,
)
from .helpers import (
    _get_node_service,
    _get_undo_service,
    _node_snapshot,
    _node_to_response,
    _get_class_ids,
    _get_tag_ids,
    _get_class_ids_batch,
    _get_alias_ids,
    _get_related_ids_batch,
    extract_properties_dict,
    _resolve_referenced_display_names,
    _name_text,
    _apply_node_extras,
)

limiter = Limiter(key_func=get_remote_address)
router = APIRouter()

@router.get("/{node_id}/versions/{version_id}", name="get_node_version")
async def get_node_version(
    node_id: int,
    version_id: int,
    user: User = Depends(get_current_user),
):
    """Get a specific version of a node."""
    service = await _get_node_service(user)
    
    async with acquire_connection(service.pool) as conn:
        row = await conn.fetchrow("""
            SELECT nv.id, nv.name, nv.created_at, nv.user_id,
                   u.username
            FROM node_version nv
            LEFT JOIN "user" u ON u.id = nv.user_id
            WHERE nv.id = $1 AND nv.node_id = $2 AND nv.workspace_id = $3
        """, version_id, node_id, service.workspace_id)
    
    if not row:
        raise HTTPException(404, "Version not found")
    
    return {
        "id": row['id'],
        "name": row['name'],
        "created_at": row['created_at'].isoformat() if row['created_at'] else None,
        "user": row['username'],
    }

