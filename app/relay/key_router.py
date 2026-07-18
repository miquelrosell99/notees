"""FastAPI router for workspace key management.

These endpoints implement a *prototype* server-side wrapping scheme so each
workspace member can retrieve and unwrap the workspace master key. Phase 6
should move to true client-side key generation for full E2EE.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from app.relay.dependencies import get_actor_id, get_key_management_service
from app.relay.key_management import KeyManagementService, PermissionDeniedError
from app.relay.key_models import (
    InviteKeyRequest,
    KeyResponse,
    RotateKeyRequest,
    RotateKeyResponse,
)

router = APIRouter(prefix="/keys", tags=["relay-keys"])


def _handle_permission_error(exc: PermissionDeniedError) -> None:
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=str(exc),
    ) from exc


@router.get("/{workspace_id}", response_model=KeyResponse)
async def get_workspace_key(
    workspace_id: str,
    actor_id: str = Depends(get_actor_id),
    service: KeyManagementService = Depends(get_key_management_service),
) -> dict[str, Any]:
    """Return the caller's wrapped copy of the workspace master key."""
    if actor_id == "anonymous":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )
    try:
        return await service.get_key(workspace_id, actor_id)
    except PermissionDeniedError as exc:
        _handle_permission_error(exc)


@router.post("/{workspace_id}/invite", response_model=KeyResponse)
async def invite_workspace_member_key(
    workspace_id: str,
    request: InviteKeyRequest,
    actor_id: str = Depends(get_actor_id),
    service: KeyManagementService = Depends(get_key_management_service),
) -> dict[str, Any]:
    """Provision or return a wrapped key for the target user.

    Restricted to workspace owners and admins.
    """
    if actor_id == "anonymous":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )
    try:
        return await service.invite_member(
            workspace_id,
            actor_id,
            request.target_user_id,
        )
    except PermissionDeniedError as exc:
        _handle_permission_error(exc)


@router.post("/{workspace_id}/rotate", response_model=RotateKeyResponse)
async def rotate_workspace_key(
    workspace_id: str,
    _request: RotateKeyRequest,
    actor_id: str = Depends(get_actor_id),
    service: KeyManagementService = Depends(get_key_management_service),
) -> dict[str, Any]:
    """Rotate the workspace master key and re-wrap it for all members.

    Restricted to workspace owners and admins.
    """
    if actor_id == "anonymous":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )
    try:
        return await service.rotate_key(workspace_id, actor_id)
    except PermissionDeniedError as exc:
        _handle_permission_error(exc)
