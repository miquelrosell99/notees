"""Undo / Redo API router."""
from fastapi import APIRouter, Depends, HTTPException

from ..auth import get_current_user
from ...models import User
from ...db.connection import get_pool
from ...dependencies import _get_workspace_context_cached
from ...domain.services.undo_service import UndoService

router = APIRouter(prefix="/api/undo", tags=["undo"])


async def _get_undo_service(user: User) -> UndoService:
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    return UndoService(pool, workspace_id, user_id)


@router.post("/undo")
async def undo(user: User = Depends(get_current_user)):
    """Undo the most recent operation."""
    service = await _get_undo_service(user)
    result = await service.undo()
    if result is None:
        raise HTTPException(status_code=404, detail="Nothing to undo")
    return result


@router.post("/redo")
async def redo(user: User = Depends(get_current_user)):
    """Redo the most recently undone operation."""
    service = await _get_undo_service(user)
    result = await service.redo()
    if result is None:
        raise HTTPException(status_code=404, detail="Nothing to redo")
    return result


@router.get("/stack")
async def get_stack(user: User = Depends(get_current_user)):
    """Get the current undo/redo stack counts."""
    service = await _get_undo_service(user)
    return await service.get_stack_info()
