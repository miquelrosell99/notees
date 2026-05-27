"""Template operations for nodes."""

from fastapi import APIRouter, Depends, HTTPException, Path
from slowapi import Limiter
from slowapi.util import get_remote_address

from ...logging_config import get_logger

logger = get_logger(__name__)

from ...models import User
from ..auth import get_current_user
from .helpers import (
    _get_node_service,
)
from .models import (
    TemplateVariablesResponse,
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
