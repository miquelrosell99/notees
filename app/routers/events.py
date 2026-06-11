"""Server-Sent Events (SSE) endpoint for workspace-level changes.

Provides a real-time event stream for third-party clients that cannot
use WebSockets or need a simple HTTP-based push mechanism.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from starlette.status import HTTP_404_NOT_FOUND

from ..db.connection import get_pool
from ..dependencies import _get_workspace_context_cached
from ..domain.permissions import PermissionChecker
from ..infrastructure.redis_pubsub import collab_pubsub
from ..logging_config import get_logger
from ..models import User
from .auth import get_current_user

logger = get_logger(__name__)

router = APIRouter(prefix="/events", tags=["Events"])


async def _event_stream(
    workspace_id: int,
    user_id: int,
    request: Request,
) -> asyncio.AsyncGenerator[str, None]:
    """Generate SSE events for a workspace.

    Yields 'data: {...}\n\n' formatted SSE messages.
    """
    channel = f"workspace:{workspace_id}"

    # Subscribe to workspace channel via Redis
    try:
        async for raw in collab_pubsub.subscribe(channel):
            # Check if client disconnected
            if await request.is_disconnected():
                break

            try:
                msg = json.loads(raw.decode())
                # Filter out messages from self
                if msg.get("sender_id") == user_id:
                    continue
                msg.pop("sender_id", None)
                yield f"data: {json.dumps(msg)}\n\n"
            except (ConnectionError, RuntimeError):
                logger.exception("Failed to process SSE message")
    except (ConnectionError, RuntimeError):
        logger.exception("SSE stream error")
    finally:
        yield f"data: {json.dumps({'type': 'close'})}\n\n"


@router.get("/workspace")
async def workspace_events(
    request: Request,
    user: User = Depends(get_current_user),
):
    """Subscribe to workspace-level events via Server-Sent Events.

    Returns a text/event-stream that pushes real-time updates for:
      - node_created
      - node_updated
      - node_deleted
      - node_moved

    Authentication: Bearer token or X-API-Key header.
    """
    pool = await get_pool()
    user_id = int(user.id)

    # Resolve active workspace

    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    if not workspace_id:
        from fastapi import HTTPException
        raise HTTPException(status_code=HTTP_404_NOT_FOUND, detail="No active workspace")

    # Verify read permission
    checker = PermissionChecker(pool, user_id)
    # Workspace-level permission check (any node in workspace)
    can_read = await checker.can_read_workspace(workspace_id)
    if not can_read:
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="Access denied")

    return StreamingResponse(
        _event_stream(workspace_id, user_id, request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering for SSE
        },
    )
