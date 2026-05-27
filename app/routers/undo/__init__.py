"""Undo / Redo API router."""

from fastapi import APIRouter, Depends, HTTPException

from ...db.connection import get_pool
from ...dependencies import _get_workspace_context_cached
from ...domain.services.undo_service import UndoService
from ...models import User
from ..auth import get_current_user

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
    """Get the current undo/redo stack counts and entries."""
    service = await _get_undo_service(user)
    return await service.get_stack_info()


@router.post("/undo-to/{entry_id}")
async def undo_to(entry_id: int, user: User = Depends(get_current_user)):
    """Undo all operations down to (and including) the given entry."""
    service = await _get_undo_service(user)
    results = await service.undo_to(entry_id)
    if not results:
        raise HTTPException(status_code=404, detail="Nothing to undo")
    return results


@router.post("/redo-to/{entry_id}")
async def redo_to(entry_id: int, user: User = Depends(get_current_user)):
    """Redo all operations up to (and including) the given entry."""
    service = await _get_undo_service(user)
    results = await service.redo_to(entry_id)
    if not results:
        raise HTTPException(status_code=404, detail="Nothing to redo")
    return results


@router.delete("/history")
async def clear_history(user: User = Depends(get_current_user)):
    """Clear all undo/redo history."""
    service = await _get_undo_service(user)
    await service.clear_history()
    return {"status": "ok"}
