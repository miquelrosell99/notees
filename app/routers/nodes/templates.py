"""Template operations for nodes."""
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
    TemplateVariablesResponse,
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

@router.get("/{node_id}/template-variables", name="get_template_variables")
async def get_template_variables(
    node_id: int = Path(..., ge=1, description="Node ID of the template"),
    user: User = Depends(get_current_user),
):
    """Return the list of {{variable}} placeholders found in a template node and its descendants."""
    service = await _get_node_service(user)

    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    if not node.is_template:
        raise HTTPException(422, "Node is not a template")

    variables = await service.extract_template_variables(node_id)
    return TemplateVariablesResponse(variables=variables)

