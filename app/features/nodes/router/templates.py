"""Template operations for nodes."""

from fastapi import APIRouter, Depends, HTTPException, Path

from app.dependencies import get_current_user
from app.logging_config import get_logger
from app.models import User

from .helpers import (
    _get_node_service,
)
from .models import (
    TemplateVariablesResponse,
)

logger = get_logger(__name__)

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
