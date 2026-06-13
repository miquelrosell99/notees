"""Undo / Redo API router."""

from fastapi import APIRouter, Depends, HTTPException

from ...dependencies import get_current_user, get_undo_repository
from ...domain.repositories.interfaces import UndoRepository
from ...models import User

router = APIRouter(prefix="/undo", tags=["undo"])


@router.post("/undo")
async def undo(
    user: User = Depends(get_current_user),
    undo_repo: UndoRepository = Depends(get_undo_repository),
):
    """Undo the most recent operation."""
    from ...domain.services.undo_service import UndoService

    service = UndoService(undo_repo)
    result = await service.undo()
    if result is None:
        raise HTTPException(status_code=404, detail="Nothing to undo")
    return result


@router.post("/redo")
async def redo(
    user: User = Depends(get_current_user),
    undo_repo: UndoRepository = Depends(get_undo_repository),
):
    """Redo the most recently undone operation."""
    from ...domain.services.undo_service import UndoService

    service = UndoService(undo_repo)
    result = await service.redo()
    if result is None:
        raise HTTPException(status_code=404, detail="Nothing to redo")
    return result


@router.get("/stack")
async def get_stack(
    user: User = Depends(get_current_user),
    undo_repo: UndoRepository = Depends(get_undo_repository),
):
    """Get the current undo/redo stack counts and entries."""
    from ...domain.services.undo_service import UndoService

    service = UndoService(undo_repo)
    return await service.get_stack_info()


@router.post("/undo-to/{entry_id}")
async def undo_to(
    entry_id: int,
    user: User = Depends(get_current_user),
    undo_repo: UndoRepository = Depends(get_undo_repository),
):
    """Undo all operations down to (and including) the given entry."""
    from ...domain.services.undo_service import UndoService

    service = UndoService(undo_repo)
    results = await service.undo_to(entry_id)
    if not results:
        raise HTTPException(status_code=404, detail="Nothing to undo")
    return results


@router.post("/redo-to/{entry_id}")
async def redo_to(
    entry_id: int,
    user: User = Depends(get_current_user),
    undo_repo: UndoRepository = Depends(get_undo_repository),
):
    """Redo all operations up to (and including) the given entry."""
    from ...domain.services.undo_service import UndoService

    service = UndoService(undo_repo)
    results = await service.redo_to(entry_id)
    if not results:
        raise HTTPException(status_code=404, detail="Nothing to redo")
    return results


@router.delete("/history")
async def clear_history(
    user: User = Depends(get_current_user),
    undo_repo: UndoRepository = Depends(get_undo_repository),
):
    """Clear all undo/redo history."""
    from ...domain.services.undo_service import UndoService

    service = UndoService(undo_repo)
    await service.clear_history()
    return {"status": "ok"}
