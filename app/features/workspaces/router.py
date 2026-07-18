"""Workspace management router.

Handles workspace creation, switching, import/export, and member management.
Routers are thin: validation, auth, and response formatting only.  Persistence
and orchestration live in domain services and repositories.
"""

import asyncio
import json
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.dependencies import (
    get_current_user,
    get_settings_repository,
    invalidate_workspace_cache,
    require_read_or_write_scope,
    require_write_scope,
)
from app.domain.repositories.interfaces import SettingsRepository
from app.export_jobs import create_job, get_job, update_job
from app.features.workspaces.dependencies import (
    _get_workspace_io_service,
    get_workspace_io_service,
    get_workspace_service,
)
from app.features.workspaces.io_service import WorkspaceIOService
from app.features.workspaces.manager import (
    create_workspace,
    delete_workspace,
    list_workspaces,
    rename_workspace,
    switch_workspace,
)
from app.features.workspaces.service import WorkspaceService
from app.logging_config import get_logger
from app.models import PaginatedResponse, User, WorkspaceCreate
from app.utils.datetime_utils import utc_now

router = APIRouter(
    prefix="/workspaces",
    tags=["Workspaces"],
    dependencies=[Depends(get_current_user), Depends(require_read_or_write_scope)],
)
logger = get_logger(__name__)


def _workspace_error_to_http(error: Exception) -> HTTPException:
    """Convert domain errors to HTTP exceptions."""
    if isinstance(error, ValueError):
        return HTTPException(status_code=400, detail=str(error))
    if isinstance(error, PermissionError):
        return HTTPException(status_code=403, detail=str(error))
    return HTTPException(status_code=500, detail=str(error))


@router.get("/")
async def list_workspaces_endpoint(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(get_current_user),
):
    """List all available workspaces for current user."""
    workspaces = await list_workspaces(user.id)
    total = len(workspaces)
    offset = (page - 1) * page_size
    items = workspaces[offset : offset + page_size]
    return PaginatedResponse[dict](
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        has_next=(page * page_size) < total,
        has_prev=page > 1,
    )


@router.get("/check-name/{name}")
async def check_workspace_name(name: str, user: User = Depends(get_current_user)):
    """Check if a workspace name is available."""
    workspaces = await list_workspaces(user.id)
    exists = any(w["name"] == name for w in workspaces)
    return {"available": not exists, "name": name}


@router.post("/", dependencies=[Depends(require_write_scope)])
async def create_workspace_endpoint(data: WorkspaceCreate, user: User = Depends(get_current_user)):
    """Create a new workspace."""
    try:
        workspace = await create_workspace(user.id, data.name)
        invalidate_workspace_cache(int(user.id))
        return workspace
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/{workspace_uuid}/switch", dependencies=[Depends(require_write_scope)])
async def switch_workspace_endpoint(workspace_uuid: str, user: User = Depends(get_current_user)):
    """Switch to a different workspace by UUID."""
    success = await switch_workspace(user.id, workspace_uuid)
    if not success:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_uuid}' not found")
    invalidate_workspace_cache(int(user.id))
    return {"status": "ok", "active": workspace_uuid}


@router.get("/{workspace_uuid}/settings", dependencies=[Depends(require_read_or_write_scope)])
async def get_workspace_settings_endpoint(
    workspace_uuid: str,
    user: User = Depends(get_current_user),
    settings_repo: SettingsRepository = Depends(get_settings_repository),
):
    """Get all settings for a workspace."""
    workspace_id = await settings_repo.get_workspace_id_by_uuid(workspace_uuid)
    if workspace_id is None:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_uuid}' not found")
    return await settings_repo.get_workspace_settings(workspace_id)


@router.put("/{workspace_uuid}/settings/{key}", dependencies=[Depends(require_write_scope)])
async def set_workspace_setting_endpoint(
    workspace_uuid: str,
    key: str,
    data: dict,
    user: User = Depends(get_current_user),
    settings_repo: SettingsRepository = Depends(get_settings_repository),
):
    """Set a single workspace setting."""
    workspace_id = await settings_repo.get_workspace_id_by_uuid(workspace_uuid)
    if workspace_id is None:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_uuid}' not found")
    await settings_repo.set_workspace_setting(workspace_id, key, data.get("value"), utc_now(), int(user.id))
    return {"success": True}


@router.put("/{name}/rename", dependencies=[Depends(require_write_scope)])
async def rename_workspace_endpoint(name: str, data: WorkspaceCreate, user: User = Depends(get_current_user)):
    """Rename a workspace."""
    try:
        workspace = await rename_workspace(user.id, name, data.name)
        return workspace
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/{uuid}", dependencies=[Depends(require_write_scope)])
async def delete_workspace_endpoint(uuid: str, user: User = Depends(get_current_user)):
    """Delete a workspace by UUID."""
    try:
        success = await delete_workspace(user.id, uuid)
        if not success:
            raise HTTPException(status_code=404, detail=f"Workspace '{uuid}' not found")
        return {"status": "ok"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/{name}/export")
async def export_workspace(
    name: str,
    format: str = "dump",
    include_assets: bool = False,
    workspace_service: WorkspaceService = Depends(get_workspace_service),
    workspace_io_service: WorkspaceIOService = Depends(get_workspace_io_service),
    user: User = Depends(get_current_user),
):
    """Export a workspace.

    Formats:
        - dump:     Comprehensive JSON dump (default)
        - markdown: ZIP of all pages as .md files with YAML frontmatter
        - text:     ZIP of all pages as .txt plain text files
        - json:     ZIP of all pages as .json AST files
    """
    try:
        if format == "dump":
            export_path = await workspace_io_service.export_workspace_to_file(user.id, name)
            return FileResponse(
                export_path,
                filename=export_path.name,
                media_type="application/json",
            )

        if format not in ("markdown", "text", "json"):
            raise HTTPException(status_code=400, detail=f"Invalid format: {format}")

        ws_uuid = await workspace_service.get_workspace_uuid_by_name(name, int(user.id))
        if not ws_uuid:
            raise ValueError(f"Workspace '{name}' not found")

        zip_path = await workspace_io_service.export_workspace_formatted_zip(
            user.id, ws_uuid, format, include_assets=include_assets
        )
        return FileResponse(
            zip_path,
            filename=zip_path.name,
            media_type="application/zip",
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.get("/{workspace_uuid}/export-by-uuid")
async def export_workspace_by_id(
    workspace_uuid: str,
    format: str = "dump",
    include_assets: bool = False,
    workspace_io_service: WorkspaceIOService = Depends(get_workspace_io_service),
    user: User = Depends(get_current_user),
):
    """Export a workspace by UUID."""
    try:
        if format == "dump":
            export_path = await workspace_io_service.export_workspace_by_uuid(user.id, workspace_uuid)
            return FileResponse(
                export_path,
                filename=export_path.name,
                media_type="application/json",
            )

        if format not in ("markdown", "text", "json"):
            raise HTTPException(status_code=400, detail=f"Invalid format: {format}")

        zip_path = await workspace_io_service.export_workspace_formatted_zip(
            user.id, workspace_uuid, format, include_assets=include_assets
        )
        return FileResponse(
            zip_path,
            filename=zip_path.name,
            media_type="application/zip",
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.get("/{workspace_uuid}/export-zip")
async def export_workspace_zip_endpoint(
    workspace_uuid: str,
    workspace_io_service: WorkspaceIOService = Depends(get_workspace_io_service),
    user: User = Depends(get_current_user),
):
    """Export a workspace as a ZIP containing the JSON dump and all asset files."""
    try:
        zip_path = await workspace_io_service.export_workspace_zip(user.id, workspace_uuid)
        return FileResponse(zip_path, filename=zip_path.name, media_type="application/zip")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


async def _run_export_job(
    job_uuid: str,
    user_id: str,
    workspace_uuid: str,
    format: str,
    include_assets: bool,
) -> None:
    """Background task that performs the actual export."""
    from app.db.connection import clear_request_conn

    clear_request_conn()

    try:
        update_job(job_uuid, status="running")
        from app.export_jobs import make_progress_callback

        callback = make_progress_callback(job_uuid)

        # Build a fresh service instance; request-scoped dependencies must not
        # be passed into background tasks.
        from app.models import User

        user = User(id=user_id, email="")
        workspace_io_service = await _get_workspace_io_service(user)

        if format == "dump":
            if include_assets:
                path = await workspace_io_service.export_workspace_zip(
                    user_id, workspace_uuid, progress_callback=callback
                )
            else:
                path = await workspace_io_service.export_workspace_by_uuid(user_id, workspace_uuid)
                update_job(job_uuid, progress=100, status_text="Export complete")
        elif format in ("markdown", "text", "json"):
            path = await workspace_io_service.export_workspace_formatted_zip(
                user_id, workspace_uuid, format, include_assets, progress_callback=callback
            )
        else:
            update_job(job_uuid, status="failed", error=f"Invalid format: {format}")
            return

        update_job(job_uuid, status="completed", progress=100, result_path=str(path))
    except Exception as exc:
        logger.error(f"Export job {job_uuid} failed: {exc}", exc_info=True)
        update_job(job_uuid, status="failed", error=str(exc))


@router.post("/{workspace_uuid}/export-job")
async def create_workspace_export_job(
    workspace_uuid: str,
    format: str = "dump",
    include_assets: bool = False,
    user: User = Depends(get_current_user),
):
    """Start an async workspace export job."""
    try:
        job = create_job()
        logger.info(
            f"Created export job {job.id} for workspace {workspace_uuid} "
            f"(format={format}, assets={include_assets})"
        )
        asyncio.create_task(
            _run_export_job(job.id, user.id, workspace_uuid, format, include_assets)
        )
        return {"job_uuid": job.id}
    except Exception as exc:
        logger.error(f"Failed to create export job: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class ExportJobResponse(BaseModel):
    job_uuid: str
    status: str
    progress: int
    status_text: str
    download_url: str | None = None
    error: str | None = None


@router.get("/export-jobs/{job_uuid}", response_model=ExportJobResponse)
async def get_workspace_export_job(job_uuid: str, user: User = Depends(get_current_user)):
    """Get the status of an export job."""
    job = get_job(job_uuid)
    if job is None:
        raise HTTPException(status_code=404, detail="Export job not found")

    download_url = None
    if job.status == "completed" and job.result_path:
        download_url = f"/api/workspaces/export-jobs/{job.id}/download"

    return ExportJobResponse(
        job_uuid=job.id,
        status=job.status,
        progress=job.progress,
        status_text=job.status_text,
        download_url=download_url,
        error=job.error,
    )


@router.get("/export-jobs/{job_uuid}/download")
async def download_workspace_export_job(job_uuid: str, user: User = Depends(get_current_user)):
    """Download the result of a completed export job."""
    job = get_job(job_uuid)
    if job is None:
        raise HTTPException(status_code=404, detail="Export job not found")
    if job.status != "completed":
        raise HTTPException(status_code=400, detail="Export job is not completed yet")
    if not job.result_path:
        raise HTTPException(status_code=500, detail="Export result missing")

    path = Path(job.result_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Export file no longer available")

    media_type = "application/zip" if path.suffix == ".zip" else "application/json"
    return FileResponse(path, filename=path.name, media_type=media_type)


@router.post("/import", dependencies=[Depends(require_write_scope)])
async def import_workspace(
    file: UploadFile = File(...),
    name: str = Form(...),
    cleanup_invalid_cloze: bool = Query(False, description="Strip cloze class from blocks that are not inside a card"),
    workspace_io_service: WorkspaceIOService = Depends(get_workspace_io_service),
    user: User = Depends(get_current_user),
):
    """Import a workspace from a dump file (JSON) or full export (ZIP)."""
    filename = file.filename or ""
    is_zip = filename.lower().endswith(".zip") or file.content_type == "application/zip"

    suffix = ".zip" if is_zip else ".json"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)

    try:
        if is_zip:
            result = await workspace_io_service.import_workspace_from_zip(
                user_id_str=user.id,
                zip_path=tmp_path,
                workspace_name=name,
                cleanup_invalid_cloze=cleanup_invalid_cloze,
            )
        else:
            with open(tmp_path, encoding="utf-8") as f:
                dump_data = json.load(f)

            result = await workspace_io_service.import_dump_to_new_workspace(
                user_id_str=user.id,
                dump_data=dump_data,
                workspace_name=name,
                cleanup_invalid_cloze=cleanup_invalid_cloze,
            )
            result.pop("uuid_map", None)

        invalidate_workspace_cache(int(user.id))
        return result
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file") from None
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    finally:
        tmp_path.unlink(missing_ok=True)


@router.post("/{workspace_uuid}/restore", dependencies=[Depends(require_write_scope)])
async def restore_workspace(
    workspace_uuid: str,
    file: UploadFile = File(...),
    cleanup_invalid_cloze: bool = Query(False, description="Strip cloze class from blocks that are not inside a card"),
    workspace_io_service: WorkspaceIOService = Depends(get_workspace_io_service),
    user: User = Depends(get_current_user),
):
    """Restore an existing workspace to a previous state from a dump file."""
    with tempfile.NamedTemporaryFile(delete=False, suffix=".json") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)

    try:
        with open(tmp_path, encoding="utf-8") as f:
            dump_data = json.load(f)

        result = await workspace_io_service.restore_workspace_from_dump(
            user_id_str=user.id,
            workspace_uuid=workspace_uuid,
            dump_data=dump_data,
            cleanup_invalid_cloze=cleanup_invalid_cloze,
        )
        invalidate_workspace_cache(int(user.id))
        return result
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file") from None
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    finally:
        tmp_path.unlink(missing_ok=True)


class MemberInviteRequest(BaseModel):
    email: str
    role: str = "viewer"


class MemberUpdateRequest(BaseModel):
    role: str


@router.post("/{workspace_uuid}/members", dependencies=[Depends(require_write_scope)])
async def invite_member(
    workspace_uuid: str,
    body: MemberInviteRequest,
    workspace_service: WorkspaceService = Depends(get_workspace_service),
    user: User = Depends(get_current_user),
):
    """Invite a user to a workspace by email."""
    try:
        result = await workspace_service.invite_member(
            workspace_uuid=workspace_uuid,
            owner_id=int(user.id),
            email=body.email,
            role=body.role,
            inviter_name=user.name or user.email,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e


@router.get("/{workspace_uuid}/members")
async def list_members(
    workspace_uuid: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    workspace_service: WorkspaceService = Depends(get_workspace_service),
    user: User = Depends(get_current_user),
):
    """List members of a workspace."""
    try:
        return await workspace_service.list_members(
            workspace_uuid=workspace_uuid,
            user_id=int(user.id),
            page=page,
            page_size=page_size,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e


@router.put("/{workspace_uuid}/members/{member_user_uuid}", dependencies=[Depends(require_write_scope)])
async def update_member(
    workspace_uuid: str,
    member_user_uuid: str,
    body: MemberUpdateRequest,
    workspace_service: WorkspaceService = Depends(get_workspace_service),
    user: User = Depends(get_current_user),
):
    """Update a member's role in a workspace."""
    try:
        await workspace_service.update_member(
            workspace_uuid=workspace_uuid,
            owner_id=int(user.id),
            member_user_uuid=member_user_uuid,
            role=body.role,
        )
        return {"status": "ok", "role": body.role}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e


@router.delete("/{workspace_uuid}/members/{member_user_uuid}", dependencies=[Depends(require_write_scope)])
async def remove_member(
    workspace_uuid: str,
    member_user_uuid: str,
    workspace_service: WorkspaceService = Depends(get_workspace_service),
    user: User = Depends(get_current_user),
):
    """Remove a member from a workspace."""
    try:
        removed_user_id = await workspace_service.remove_member(
            workspace_uuid=workspace_uuid,
            owner_id=int(user.id),
            member_user_uuid=member_user_uuid,
        )
        invalidate_workspace_cache(removed_user_id)
        return {"status": "ok"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e


@router.delete("/{workspace_uuid}/pending-invites/{email}", dependencies=[Depends(require_write_scope)])
async def remove_pending_invite(
    workspace_uuid: str,
    email: str,
    workspace_service: WorkspaceService = Depends(get_workspace_service),
    user: User = Depends(get_current_user),
):
    """Cancel a pending invite by email."""
    try:
        await workspace_service.remove_pending_invite(
            workspace_uuid=workspace_uuid,
            owner_id=int(user.id),
            email=email,
        )
        return {"status": "ok"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e


class SyncProtocolVersionUpdate(BaseModel):
    version: str


@router.get("/{workspace_uuid}/sync-protocol-version")
async def get_sync_protocol_version(
    workspace_uuid: str,
    workspace_service: WorkspaceService = Depends(get_workspace_service),
    user: User = Depends(get_current_user),
):
    """Get the sync protocol version for a workspace."""
    try:
        version = await workspace_service.get_sync_protocol_version(workspace_uuid, int(user.id))
        return {"sync_protocol_version": version}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.patch("/{workspace_uuid}/sync-protocol-version", dependencies=[Depends(require_write_scope)])
async def update_sync_protocol_version(
    workspace_uuid: str,
    body: SyncProtocolVersionUpdate,
    workspace_service: WorkspaceService = Depends(get_workspace_service),
    user: User = Depends(get_current_user),
):
    """Update the sync protocol version for a workspace (owner only)."""
    try:
        await workspace_service.set_sync_protocol_version(
            workspace_uuid, int(user.id), body.version
        )
        return {"sync_protocol_version": body.version}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
