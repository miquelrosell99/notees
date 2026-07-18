"""Undo / Redo API router (deprecated).

The server-side undo stack has been removed as part of the Phase 7 migration to
the local-first operation log. Undo is now implemented client-side by generating
inverse operations (``property.unset`` for ``property.set``, reverse
``node.move``, ``node.delete`` for created nodes, etc.) and appending them to
the local operation log.

All legacy endpoints under ``/undo`` return ``410 Gone`` so that clients receive
a clear, actionable failure instead of a missing route or silent no-op.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.dependencies import get_current_user, require_read_or_write_scope

router = APIRouter(
    prefix="/undo",
    tags=["undo"],
    dependencies=[Depends(get_current_user), Depends(require_read_or_write_scope)],
)

_GONE_DETAIL = {
    "message": "Server-side undo has been deprecated. Undo is now implemented client-side by generating inverse operations and appending them to the local operation log."
}


@router.post("/undo")
async def undo() -> dict:
    """Undo the most recent operation.

    .. deprecated::
        Server-side undo is no longer supported. Clients should generate and
        append inverse operations locally.
    """
    from fastapi import HTTPException

    raise HTTPException(status_code=410, detail=_GONE_DETAIL)


@router.post("/redo")
async def redo() -> dict:
    """Redo the most recently undone operation.

    .. deprecated::
        Server-side redo is no longer supported. Clients should generate and
        append inverse operations locally.
    """
    from fastapi import HTTPException

    raise HTTPException(status_code=410, detail=_GONE_DETAIL)


@router.get("/stack")
async def get_stack() -> dict:
    """Get the current undo/redo stack counts and entries.

    .. deprecated::
        Server-side undo stack is no longer maintained. Undo state lives in the
        client-side operation log.
    """
    from fastapi import HTTPException

    raise HTTPException(status_code=410, detail=_GONE_DETAIL)


@router.post("/undo-to/{entry_uuid}")
async def undo_to(entry_uuid: str) -> dict:
    """Undo all operations down to (and including) the given entry.

    .. deprecated::
        Server-side undo is no longer supported. Clients should generate and
        append inverse operations locally.
    """
    from fastapi import HTTPException

    raise HTTPException(status_code=410, detail=_GONE_DETAIL)


@router.post("/redo-to/{entry_uuid}")
async def redo_to(entry_uuid: str) -> dict:
    """Redo all operations up to (and including) the given entry.

    .. deprecated::
        Server-side redo is no longer supported. Clients should generate and
        append inverse operations locally.
    """
    from fastapi import HTTPException

    raise HTTPException(status_code=410, detail=_GONE_DETAIL)


@router.delete("/history")
async def clear_history() -> dict:
    """Clear all undo/redo history.

    .. deprecated::
        Server-side undo history is no longer maintained. Clients manage undo
        state locally.
    """
    from fastapi import HTTPException

    raise HTTPException(status_code=410, detail=_GONE_DETAIL)
