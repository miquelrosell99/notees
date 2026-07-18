"""REST endpoints for Yjs CRDT state.

These endpoints are compatibility shims during the Phase 7 migration. The
source of truth for Yjs state is the encrypted operation relay
(``/api/relay/batch`` and ``/api/relay/catch-up``); these endpoints wrap
incoming Yjs text updates as ``node.updateContent`` operations and read the
latest text CRDT state from the derived SQLite store.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from app.config import settings
from app.core.workspace_store import WorkspaceStore
from app.dependencies import get_current_user, require_read_or_write_scope, require_write_scope
from app.models import User

from .dependencies import get_workspace_store

router = APIRouter(
    prefix="/nodes",
    tags=["Yjs"],
    dependencies=[Depends(get_current_user), Depends(require_read_or_write_scope)],
)


@router.get("/{node_uuid}/yjs_state")
async def get_yjs_state(
    node_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
    store: WorkspaceStore = Depends(get_workspace_store),
) -> Response:
    """Return the latest Yjs text state blob stored for a node.

    The server does not merge Yjs updates; it returns the most recently stored
    ``textUpdate`` payload from the derived ``crdt_state`` table. Clients should
    prefer pulling the full operation log via ``/api/relay/catch-up``.
    """
    await store.sync()
    rows = await store.query(
        "SELECT text_state FROM crdt_state WHERE node_id = ?",
        (node_uuid,),
    )
    blob = rows[0]["text_state"] if rows else None
    return Response(
        content=blob if blob is not None else b"",
        media_type="application/octet-stream",
    )


@router.post(
    "/{node_uuid}/yjs_update",
    dependencies=[Depends(require_write_scope)],
)
async def apply_yjs_update(
    node_uuid: str,
    request: Request,
    user: User = Depends(get_current_user),  # noqa: B008
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, str]:
    """Append a raw Yjs text update as a ``node.updateContent`` operation.

    The update is persisted to the encrypted operation relay and applied to the
    derived SQLite store; it is broadcast to other clients through the relay
    WebSocket (``/api/relay/ws/{workspace_id}``).
    """
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            size = int(content_length)
        except ValueError:
            size = 0
        if size > settings.yjs_max_update_size_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Yjs update too large. Maximum size is {settings.yjs_max_update_size_bytes} bytes.",
            )
    body = await request.body()
    if len(body) > settings.yjs_max_update_size_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Yjs update too large. Maximum size is {settings.yjs_max_update_size_bytes} bytes.",
        )

    await store.sync()
    node_rows = await store.query("SELECT 1 FROM node WHERE id = ?", (node_uuid,))
    if not node_rows:
        raise HTTPException(status_code=404, detail="Node not found")

    await store.update_text_crdt(node_uuid, body)
    return {"status": "ok"}
