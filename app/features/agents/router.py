"""External agent REST API router.

Exposes a machine-friendly API for reading and writing notes using API keys.
All endpoints live under ``/api/agents/v1``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi_limiter.depends import RateLimiter
from pyrate_limiter import Duration

from app.core.workspace_store import WorkspaceStore
from app.dependencies import RequireScope, get_current_user
from app.features.workspaces.dependencies import get_workspace_repository
from app.features.workspaces.port import WorkspaceRepository
from app.models import User
from app.rate_limit import per_user_limiter, user_identifier

from . import schemas
from .dependencies import get_agent_workspace_store
from .service import AgentService

router = APIRouter(
    prefix="/api/agents/v1",
    tags=["agents"],
    dependencies=[Depends(RateLimiter(limiter=per_user_limiter(60, Duration.MINUTE), identifier=user_identifier))],
)

_write_scope = RequireScope("write")


def _service(
    store: WorkspaceStore = Depends(get_agent_workspace_store),  # noqa: B008
    workspace_repo: WorkspaceRepository = Depends(get_workspace_repository),  # noqa: B008
) -> AgentService:
    """Build an ``AgentService`` for the request."""
    return AgentService(store, workspace_repo)


@router.get("/workspaces", response_model=list[schemas.WorkspaceListItem])
async def list_workspaces(
    user: User = Depends(get_current_user),  # noqa: B008
    workspace_repo: WorkspaceRepository = Depends(get_workspace_repository),  # noqa: B008
):
    """List workspaces the authenticated user can access."""
    service = AgentService(
        store=None,  # type: ignore[arg-type]
        workspace_repo=workspace_repo,
    )
    return await service.list_workspaces(int(user.id))


@router.get("/workspaces/{workspace_uuid}", response_model=schemas.WorkspaceDetail)
async def get_workspace(
    workspace_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
    workspace_repo: WorkspaceRepository = Depends(get_workspace_repository),  # noqa: B008
):
    """Get details for a single workspace."""
    service = AgentService(
        store=None,  # type: ignore[arg-type]
        workspace_repo=workspace_repo,
    )
    try:
        return await service.get_workspace(workspace_uuid, int(user.id))
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace not found",
        ) from exc


@router.get("/workspaces/{workspace_uuid}/nodes", response_model=list[schemas.NodeListItem])
async def search_nodes(
    workspace_uuid: str,
    q: str = Query(default=""),
    kind: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    service: AgentService = Depends(_service),  # noqa: B008
):
    """Search nodes in a workspace by title or content."""
    return await service.search_nodes(q, kind, limit)


@router.get("/workspaces/{workspace_uuid}/nodes/{node_uuid}", response_model=schemas.NodeDetail)
async def get_node(
    workspace_uuid: str,
    node_uuid: str,
    service: AgentService = Depends(_service),  # noqa: B008
):
    """Get full details for a node."""
    try:
        return await service.get_node(node_uuid)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Node not found",
        ) from exc


@router.get(
    "/workspaces/{workspace_uuid}/nodes/{node_uuid}/references",
    response_model=schemas.ReferencesResponse,
)
async def get_references(
    workspace_uuid: str,
    node_uuid: str,
    service: AgentService = Depends(_service),  # noqa: B008
):
    """Get outgoing references and backlinks for a node."""
    return await service.get_references(node_uuid)


@router.get(
    "/workspaces/{workspace_uuid}/nodes/{node_uuid}/activity",
    response_model=list[schemas.ActivityItem],
)
async def get_activity(
    workspace_uuid: str,
    node_uuid: str,
    since: schemas.ActivityQueryParams = Depends(),  # noqa: B008
    service: AgentService = Depends(_service),  # noqa: B008
):
    """Get activity log entries for a node."""
    return await service.get_activity(node_uuid, since.since)


@router.post(
    "/workspaces/{workspace_uuid}/nodes",
    response_model=schemas.NodeCreateResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(_write_scope)],
)
async def create_node(
    workspace_uuid: str,
    body: schemas.NodeCreateRequest,
    service: AgentService = Depends(_service),  # noqa: B008
):
    """Create a new node in a workspace."""
    node_id = await service.create_node(
        kind=body.kind,
        parent_id=body.parent_id,
        title=body.title,
        class_ids=body.class_ids,
        initial_content=body.initial_content,
    )
    return schemas.NodeCreateResponse(id=node_id)


@router.patch(
    "/workspaces/{workspace_uuid}/nodes/{node_uuid}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(_write_scope)],
)
async def update_node(
    workspace_uuid: str,
    node_uuid: str,
    body: schemas.NodeUpdateRequest,
    service: AgentService = Depends(_service),  # noqa: B008
):
    """Update a node's title or content."""
    await service.update_node(
        node_uuid,
        title=body.title,
        content=body.content,
    )


@router.post(
    "/workspaces/{workspace_uuid}/nodes/{node_uuid}/properties",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(_write_scope)],
)
async def set_property(
    workspace_uuid: str,
    node_uuid: str,
    body: schemas.SetPropertyRequest,
    service: AgentService = Depends(_service),  # noqa: B008
):
    """Set a property value on a node."""
    await service.set_property(
        node_uuid,
        schema_id=body.schema_id,
        value=body.value,
    )


@router.post(
    "/workspaces/{workspace_uuid}/nodes/{node_uuid}/notes",
    response_model=schemas.NodeCreateResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(_write_scope)],
)
async def append_note(
    workspace_uuid: str,
    node_uuid: str,
    body: schemas.AppendNoteRequest,
    service: AgentService = Depends(_service),  # noqa: B008
):
    """Append a child text block to a node."""
    child_id = await service.append_note(node_uuid, body.text)
    return schemas.NodeCreateResponse(id=child_id)
