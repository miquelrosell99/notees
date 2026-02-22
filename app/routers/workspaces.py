"""Workspace management router.

Handles workspace creation, switching, import/export, and restore.
Uses domain types where applicable.
"""
from fastapi import APIRouter, HTTPException, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse
from pathlib import Path
import json
import tempfile
import shutil

from ..models import WorkspaceCreate, User
from ..domain import WorkspaceNotFoundError, DuplicateWorkspaceError
from ..dependencies import invalidate_workspace_cache
from .auth import get_current_user

from .. import database as db
from ..workspace_io import (
    import_dump_to_new_workspace,
    restore_workspace_from_dump,
    export_workspace_to_file,
    export_workspace_by_uuid,
)

router = APIRouter(prefix="/api/workspaces", tags=["Workspaces"])


def _workspace_error_to_http(error: Exception) -> HTTPException:
    """Convert domain errors to HTTP exceptions."""
    if isinstance(error, WorkspaceNotFoundError):
        return HTTPException(status_code=404, detail=error.message)
    elif isinstance(error, DuplicateWorkspaceError):
        return HTTPException(status_code=409, detail=error.message)
    else:
        return HTTPException(status_code=500, detail=str(error))


@router.get("")
async def list_workspaces(user: User = Depends(get_current_user)):
    """List all available workspaces for current user."""
    workspaces = await db.list_workspaces(user.id)
    active_uuid = db.get_active_workspace_id(user.id)
    return {"workspaces": workspaces, "active": active_uuid}


@router.get("/check-name/{name}")
async def check_workspace_name(name: str, user: User = Depends(get_current_user)):
    """Check if a workspace name is available."""
    workspaces = await db.list_workspaces(user.id)
    exists = any(w['name'] == name for w in workspaces)
    return {"available": not exists, "name": name}


@router.post("")
async def create_workspace(data: WorkspaceCreate, user: User = Depends(get_current_user)):
    """Create a new workspace."""
    try:
        workspace = await db.create_workspace(user.id, data.name)
        invalidate_workspace_cache(int(user.id))
        return workspace
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{workspace_id}/switch")
async def switch_workspace(workspace_id: str, user: User = Depends(get_current_user)):
    """Switch to a different workspace by UUID."""
    success = await db.switch_workspace(user.id, workspace_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")
    invalidate_workspace_cache(int(user.id))
    return {"status": "ok", "active": workspace_id}


@router.put("/{name}/rename")
async def rename_workspace(name: str, data: WorkspaceCreate, user: User = Depends(get_current_user)):
    """Rename a workspace."""
    try:
        workspace = await db.rename_workspace(user.id, name, data.name)
        return workspace
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{uuid}")
async def delete_workspace(uuid: str, user: User = Depends(get_current_user)):
    """Delete a workspace by UUID."""
    try:
        success = await db.delete_workspace(user.id, uuid)
        if not success:
            raise HTTPException(status_code=404, detail=f"Workspace '{uuid}' not found")
        return {"status": "ok"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{name}/export")
async def export_workspace(name: str, user: User = Depends(get_current_user)):
    """Export a workspace as a comprehensive JSON dump file.

    The dump includes all nodes, links, properties, property values,
    class definitions, node views, and settings.
    """
    try:
        export_path = await export_workspace_to_file(user.id, name)
        return FileResponse(
            export_path,
            filename=export_path.name,
            media_type="application/json"
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{workspace_id}/export-by-uuid")
async def export_workspace_by_id(
    workspace_id: str, user: User = Depends(get_current_user)
):
    """Export a workspace by UUID as a comprehensive JSON dump file."""
    try:
        export_path = await export_workspace_by_uuid(user.id, workspace_id)
        return FileResponse(
            export_path,
            filename=export_path.name,
            media_type="application/json"
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/import")
async def import_workspace(
    file: UploadFile = File(...),
    name: str = Form(...),
    user: User = Depends(get_current_user)
):
    """Import a workspace from a dump file into a new workspace.

    Creates a brand new workspace with the specified name. All UUIDs in the
    dump are remapped to new unique values so the imported workspace is
    completely independent from the source.

    The dump file should be a JSON file produced by the export endpoint.
    """
    with tempfile.NamedTemporaryFile(delete=False, suffix=".json") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)

    try:
        with open(tmp_path, 'r', encoding='utf-8') as f:
            dump_data = json.load(f)

        result = await import_dump_to_new_workspace(
            user_id_str=user.id,
            dump_data=dump_data,
            workspace_name=name,
        )
        invalidate_workspace_cache(int(user.id))
        return result
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        tmp_path.unlink(missing_ok=True)


@router.post("/{workspace_id}/restore")
async def restore_workspace(
    workspace_id: str,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """Restore an existing workspace to a previous state from a dump file.

    WARNING: This replaces ALL data in the workspace with the dump contents.
    Original UUIDs from the dump are preserved (no remapping).

    The dump file should be a JSON file produced by the export endpoint.
    """
    with tempfile.NamedTemporaryFile(delete=False, suffix=".json") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)

    try:
        with open(tmp_path, 'r', encoding='utf-8') as f:
            dump_data = json.load(f)

        result = await restore_workspace_from_dump(
            user_id_str=user.id,
            workspace_uuid=workspace_id,
            dump_data=dump_data,
        )
        invalidate_workspace_cache(int(user.id))
        return result
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        tmp_path.unlink(missing_ok=True)
