"""Undo / Redo API router."""

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_current_user
from app.features.undo.dependencies import get_undo_repository
from app.features.undo.port import UndoRepository
from app.models import User

router = APIRouter(prefix="/undo", tags=["undo"])


@router.post("/undo")
async def undo(
    user: User = Depends(get_current_user),
    undo_repo: UndoRepository = Depends(get_undo_repository),
):
    """Undo the most recent operation."""
    from app.features.undo.service import UndoService

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
    from app.features.undo.service import UndoService

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
    from app.features.undo.service import UndoService

    service = UndoService(undo_repo)
    return await service.get_stack_info()


@router.post("/undo-to/{entry_uuid}")
async def undo_to(
    entry_uuid: str,
    user: User = Depends(get_current_user),
    undo_repo: UndoRepository = Depends(get_undo_repository),
):
    """Undo all operations down to (and including) the given entry."""
    from app.features.undo.service import UndoService

    entry_id = await undo_repo.get_undo_entry_id_by_uuid(entry_uuid)
    if entry_id is None:
        raise HTTPException(status_code=404, detail="Entry not found")

    service = UndoService(undo_repo)
    results = await service.undo_to(entry_id)
    if not results:
        raise HTTPException(status_code=404, detail="Nothing to undo")
    return results


@router.post("/redo-to/{entry_uuid}")
async def redo_to(
    entry_uuid: str,
    user: User = Depends(get_current_user),
    undo_repo: UndoRepository = Depends(get_undo_repository),
):
    """Redo all operations up to (and including) the given entry."""
    from app.features.undo.service import UndoService

    entry_id = await undo_repo.get_undo_entry_id_by_uuid(entry_uuid)
    if entry_id is None:
        raise HTTPException(status_code=404, detail="Entry not found")

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
    from app.features.undo.service import UndoService

    service = UndoService(undo_repo)
    await service.clear_history()
    return {"status": "ok"}
