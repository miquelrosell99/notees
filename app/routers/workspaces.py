"""Workspace management router.

Handles workspace creation, switching, import/export, and restore.
Uses domain types where applicable.
"""

import asyncio
import json
import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import workspace_manager as wm
from ..config import settings
from ..db.connection import acquire_connection, clear_request_conn, get_pool
from ..dependencies import invalidate_workspace_cache
from ..domain import DuplicateWorkspaceError, WorkspaceNotFoundError
from ..export_jobs import create_job, get_job, update_job
from ..logging_config import get_logger
from ..models import User, WorkspaceCreate
from ..utils.email import render_invite_email, send_email
from ..workspace_io import (
    export_workspace_by_uuid,
    export_workspace_formatted_zip,
    export_workspace_to_file,
    export_workspace_zip,
    import_dump_to_new_workspace,
    import_workspace_from_zip,
    restore_workspace_from_dump,
)
from .auth import get_current_user

router = APIRouter(prefix="/workspaces", tags=["Workspaces"])
logger = get_logger(__name__)


def _workspace_error_to_http(error: Exception) -> HTTPException:
    """Convert domain errors to HTTP exceptions."""
    if isinstance(error, WorkspaceNotFoundError):
        return HTTPException(status_code=404, detail=error.message)
    elif isinstance(error, DuplicateWorkspaceError):
        return HTTPException(status_code=409, detail=error.message)
    else:
        return HTTPException(status_code=500, detail=str(error))


@router.get("/")
@router.get("")
async def list_workspaces(user: User = Depends(get_current_user)):
    """List all available workspaces for current user."""
    workspaces = await wm.list_workspaces(user.id)
    active_uuid = wm.get_active_workspace_id(user.id)
    return {"workspaces": workspaces, "active": active_uuid}


@router.get("/check-name/{name}")
async def check_workspace_name(name: str, user: User = Depends(get_current_user)):
    """Check if a workspace name is available."""
    workspaces = await wm.list_workspaces(user.id)
    exists = any(w["name"] == name for w in workspaces)
    return {"available": not exists, "name": name}


@router.post("/")
@router.post("")
async def create_workspace(data: WorkspaceCreate, user: User = Depends(get_current_user)):
    """Create a new workspace."""
    try:
        workspace = await wm.create_workspace(user.id, data.name)
        invalidate_workspace_cache(int(user.id))
        return workspace
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/{workspace_id}/switch")
async def switch_workspace(workspace_id: str, user: User = Depends(get_current_user)):
    """Switch to a different workspace by UUID."""
    success = await wm.switch_workspace(user.id, workspace_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")
    invalidate_workspace_cache(int(user.id))
    return {"status": "ok", "active": workspace_id}


@router.put("/{name}/rename")
async def rename_workspace(name: str, data: WorkspaceCreate, user: User = Depends(get_current_user)):
    """Rename a workspace."""
    try:
        workspace = await wm.rename_workspace(user.id, name, data.name)
        return workspace
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/{uuid}")
async def delete_workspace(uuid: str, user: User = Depends(get_current_user)):
    """Delete a workspace by UUID."""
    try:
        success = await wm.delete_workspace(user.id, uuid)
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
            export_path = await export_workspace_to_file(user.id, name)
            return FileResponse(
                export_path,
                filename=export_path.name,
                media_type="application/json",
            )

        if format not in ("markdown", "text", "json"):
            raise HTTPException(status_code=400, detail=f"Invalid format: {format}")

        # Resolve workspace UUID from name for formatted export
        from ..workspace_manager import _get_numeric_user_id

        numeric_user_id = await _get_numeric_user_id(user.id)
        async with acquire_connection() as conn:
            ws = await conn.fetchrow(
                """
                SELECT g.uuid::text as uuid
                FROM workspace g
                LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
                WHERE g.name = $2 AND g.active = TRUE
                  AND (g.create_uid = $1 OR gs.user_id = $1)
                """,
                numeric_user_id,
                name,
            )
        if not ws:
            raise ValueError(f"Workspace '{name}' not found")

        zip_path = await export_workspace_formatted_zip(user.id, ws["uuid"], format, include_assets=include_assets)
        return FileResponse(
            zip_path,
            filename=zip_path.name,
            media_type="application/zip",
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.get("/{workspace_id}/export-by-uuid")
async def export_workspace_by_id(
    workspace_id: str,
    format: str = "dump",
    include_assets: bool = False,
    user: User = Depends(get_current_user),
):
    """Export a workspace by UUID.

    Formats:
        - dump:     Comprehensive JSON dump (default)
        - markdown: ZIP of all pages as .md files with YAML frontmatter
        - text:     ZIP of all pages as .txt plain text files
        - json:     ZIP of all pages as .json AST files
    """
    try:
        if format == "dump":
            export_path = await export_workspace_by_uuid(user.id, workspace_id)
            return FileResponse(
                export_path,
                filename=export_path.name,
                media_type="application/json",
            )

        if format not in ("markdown", "text", "json"):
            raise HTTPException(status_code=400, detail=f"Invalid format: {format}")

        zip_path = await export_workspace_formatted_zip(user.id, workspace_id, format, include_assets=include_assets)
        return FileResponse(
            zip_path,
            filename=zip_path.name,
            media_type="application/zip",
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.get("/{workspace_id}/export-zip")
async def export_workspace_zip_endpoint(workspace_id: str, user: User = Depends(get_current_user)):
    """Export a workspace as a ZIP containing the JSON dump and all asset files.

    The ZIP includes:
    - dump.json: Full workspace data dump
    - assets/{uuid}/main.{ext}: All asset source files
    - assets/{uuid}/thumbnail.webp: Asset thumbnails
    """
    try:
        zip_path = await export_workspace_zip(user.id, workspace_id)
        return FileResponse(zip_path, filename=zip_path.name, media_type="application/zip")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


async def _run_export_job(
    job_id: str,
    user_id: str,
    workspace_id: str,
    format: str,
    include_assets: bool,
) -> None:
    """Background task that performs the actual export."""
    # Background tasks inherit the parent request's context variables,
    # including the request-scoped DB connection. Clear it so we don't
    # race with the middleware releasing the connection back to the pool.
    clear_request_conn()

    try:
        update_job(job_id, status="running")
        from ..export_jobs import make_progress_callback

        callback = make_progress_callback(job_id)

        if format == "dump":
            if include_assets:
                path = await export_workspace_zip(
                    user_id, workspace_id, progress_callback=callback
                )
            else:
                path = await export_workspace_by_uuid(user_id, workspace_id)
                update_job(job_id, progress=100, status_text="Export complete")
        elif format in ("markdown", "text", "json"):
            path = await export_workspace_formatted_zip(
                user_id, workspace_id, format, include_assets, progress_callback=callback
            )
        else:
            update_job(job_id, status="failed", error=f"Invalid format: {format}")
            return

        update_job(job_id, status="completed", progress=100, result_path=str(path))
    except Exception as exc:
        logger.error(f"Export job {job_id} failed: {exc}", exc_info=True)
        update_job(job_id, status="failed", error=str(exc))


@router.post("/{workspace_id}/export-job")
async def create_workspace_export_job(
    workspace_id: str,
    format: str = "dump",
    include_assets: bool = False,
    user: User = Depends(get_current_user),
):
    """Start an async workspace export job.

    Returns a job ID immediately. Poll GET /export-jobs/{job_id} for progress.
    When status is "completed", download from GET /export-jobs/{job_id}/download.
    """
    try:
        job = create_job()
        logger.info(f"Created export job {job.id} for workspace {workspace_id} (format={format}, assets={include_assets})")
        asyncio.create_task(
            _run_export_job(job.id, user.id, workspace_id, format, include_assets)
        )
        return {"job_id": job.id}
    except Exception as exc:
        logger.error(f"Failed to create export job: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class ExportJobResponse(BaseModel):
    id: str
    status: str
    progress: int
    status_text: str
    download_url: str | None = None
    error: str | None = None


@router.get("/export-jobs/{job_id}", response_model=ExportJobResponse)
async def get_workspace_export_job(job_id: str, user: User = Depends(get_current_user)):
    """Get the status of an export job."""
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Export job not found")

    download_url = None
    if job.status == "completed" and job.result_path:
        download_url = f"/api/workspaces/export-jobs/{job.id}/download"

    return ExportJobResponse(
        id=job.id,
        status=job.status,
        progress=job.progress,
        status_text=job.status_text,
        download_url=download_url,
        error=job.error,
    )


@router.get("/export-jobs/{job_id}/download")
async def download_workspace_export_job(job_id: str, user: User = Depends(get_current_user)):
    """Download the result of a completed export job."""
    job = get_job(job_id)
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


@router.post("/import")
async def import_workspace(file: UploadFile = File(...), name: str = Form(...), user: User = Depends(get_current_user)):
    """Import a workspace from a dump file (JSON) or full export (ZIP).

    Creates a brand new workspace with the specified name.
    - JSON import: UUIDs are remapped to new unique values (safe for same-instance copies)
    - ZIP import: Original UUIDs are preserved (for cross-instance migration)

    Accepts either:
    - A JSON dump file produced by the JSON export endpoint
    - A ZIP file produced by the full export endpoint (includes assets)
    """
    # Determine file type by extension or content type
    filename = file.filename or ""
    is_zip = filename.lower().endswith(".zip") or file.content_type == "application/zip"

    suffix = ".zip" if is_zip else ".json"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)

    try:
        if is_zip:
            result = await import_workspace_from_zip(
                user_id_str=user.id,
                zip_path=tmp_path,
                workspace_name=name,
            )
        else:
            with open(tmp_path, encoding="utf-8") as f:
                dump_data = json.load(f)

            result = await import_dump_to_new_workspace(
                user_id_str=user.id,
                dump_data=dump_data,
                workspace_name=name,
            )
            # Remove uuid_map from response (internal detail)
            result.pop("uuid_map", None)

        invalidate_workspace_cache(int(user.id))
        return result
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file") from None
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
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
        with open(tmp_path, encoding="utf-8") as f:
            dump_data = json.load(f)

        result = await restore_workspace_from_dump(
            user_id_str=user.id,
            workspace_uuid=workspace_id,
            dump_data=dump_data,
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


ROLE_PERMS = {
    "viewer": {"can_read": True, "can_write": False, "can_create": False, "can_delete": False, "can_comment": False},
    "commenter": {"can_read": True, "can_write": False, "can_create": False, "can_delete": False, "can_comment": True},
    "editor": {"can_read": True, "can_write": True, "can_create": True, "can_delete": False, "can_comment": True},
    "admin": {"can_read": True, "can_write": True, "can_create": True, "can_delete": True, "can_comment": True},
}


@router.post("/{workspace_uuid}/members")
async def invite_member(
    workspace_uuid: str,
    body: MemberInviteRequest,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Invite a user to a workspace by email."""
    pool = await get_pool()
    async with acquire_connection(pool) as conn:
        ws_row = await conn.fetchrow(
            "SELECT id, create_uid FROM workspace WHERE uuid::text = $1 AND active = TRUE",
            workspace_uuid,
        )
        if not ws_row:
            raise HTTPException(status_code=404, detail="Workspace not found")
        if ws_row["create_uid"] != int(user.id):
            raise HTTPException(status_code=403, detail="Only workspace owners can invite members")

        target = await conn.fetchrow(
            'SELECT id FROM "user" WHERE email = $1 AND active = TRUE',
            body.email,
        )
        if target:
            target_id = target["id"]
            if target_id == int(user.id):
                raise HTTPException(status_code=400, detail="Cannot invite yourself")

            perms = ROLE_PERMS.get(body.role, ROLE_PERMS["viewer"])

            await conn.execute(
                """
                INSERT INTO workspace_share (
                    workspace_id, user_id, can_read, can_write, can_create, can_delete, can_comment,
                    active, create_uid, write_uid
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $8)
                ON CONFLICT (workspace_id, user_id)
                DO UPDATE SET
                    can_read = EXCLUDED.can_read,
                    can_write = EXCLUDED.can_write,
                    can_create = EXCLUDED.can_create,
                    can_delete = EXCLUDED.can_delete,
                    can_comment = EXCLUDED.can_comment,
                    active = TRUE,
                    write_uid = EXCLUDED.write_uid,
                    write_date = NOW()
                """,
                ws_row["id"],
                target_id,
                perms["can_read"],
                perms["can_write"],
                perms["can_create"],
                perms["can_delete"],
                perms["can_comment"],
                int(user.id),
            )

            await conn.execute(
                "UPDATE workspace SET is_shared = TRUE WHERE id = $1",
                ws_row["id"],
            )

            return {"status": "ok", "email": body.email, "role": body.role}

        # Target user does not exist — create a pending invite
        from datetime import UTC, datetime, timedelta

        invite_uuid = str(uuid.uuid4())
        expires_at = datetime.now(UTC) + timedelta(days=7)
        await conn.execute(
            """
            INSERT INTO pending_invite (uuid, email, workspace_id, role, invited_by, expires_at, active)
            VALUES ($1, $2, $3, $4, $5, $6, TRUE)
            ON CONFLICT (email, workspace_id, node_id)
            DO UPDATE SET
                role = EXCLUDED.role,
                invited_by = EXCLUDED.invited_by,
                expires_at = EXCLUDED.expires_at,
                active = TRUE,
                created_at = NOW()
            """,
            invite_uuid,
            body.email,
            ws_row["id"],
            body.role,
            int(user.id),
            expires_at,
        )

        invite_link = f"{settings.public_url}/enroll?token={invite_uuid}"
        html, plain = render_invite_email(
            inviter_name=user.name or user.email,
            workspace_name=workspace_uuid,
            invite_link=invite_link,
        )
        sent = await send_email(body.email, "Invitation to collaborate on Notees", html, plain)

        return {
            "status": "pending",
            "email": body.email,
            "role": body.role,
            "invite_link": None if sent else invite_link,
        }


@router.get("/{workspace_uuid}/members")
async def list_members(
    workspace_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """List members of a workspace."""
    pool = await get_pool()
    async with acquire_connection(pool) as conn:
        ws_row = await conn.fetchrow(
            "SELECT id, create_uid FROM workspace WHERE uuid::text = $1 AND active = TRUE",
            workspace_uuid,
        )
        if not ws_row:
            raise HTTPException(status_code=404, detail="Workspace not found")

        ws_id = ws_row["id"]
        user_id = int(user.id)
        is_owner = ws_row["create_uid"] == user_id

        if not is_owner:
            member = await conn.fetchrow(
                "SELECT 1 FROM workspace_share WHERE workspace_id = $1 AND user_id = $2 AND active = TRUE",
                ws_id,
                user_id,
            )
            if not member:
                raise HTTPException(status_code=403, detail="Not a member of this workspace")

        rows = await conn.fetch(
            """
            SELECT u.id, u.email, u.uuid as user_uuid,
                   gs.can_read, gs.can_write, gs.can_create, gs.can_delete, gs.can_comment,
                   gs.create_date
            FROM workspace_share gs
            JOIN "user" u ON u.id = gs.user_id
            WHERE gs.workspace_id = $1 AND gs.active = TRUE
            ORDER BY gs.create_date DESC
            """,
            ws_id,
        )

        pending_rows = await conn.fetch(
            """
            SELECT email, role, created_at
            FROM pending_invite
            WHERE workspace_id = $1 AND node_id IS NULL AND active = TRUE
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY created_at DESC
            """,
            ws_id,
        )

        owner_row = await conn.fetchrow(
            'SELECT id, email, uuid as user_uuid FROM "user" WHERE id = $1',
            ws_row["create_uid"],
        )

    members = []
    if owner_row:
        members.append(
            {
                "user_id": owner_row["id"],
                "email": owner_row["email"],
                "user_uuid": str(owner_row["user_uuid"]),
                "role": "owner",
                "joined_at": None,
            }
        )
    for r in rows:
        role = "viewer"
        if r["can_delete"]:
            role = "admin"
        elif r["can_write"]:
            role = "editor"
        elif r["can_comment"]:
            role = "commenter"
        members.append(
            {
                "user_id": r["id"],
                "email": r["email"],
                "user_uuid": str(r["user_uuid"]),
                "role": role,
                "joined_at": r["create_date"].isoformat() if r["create_date"] else None,
            }
        )
    for p in pending_rows:
        members.append(
            {
                "user_id": None,
                "email": p["email"],
                "user_uuid": None,
                "role": p["role"],
                "joined_at": None,
                "status": "pending",
            }
        )
    return {"members": members}


@router.put("/{workspace_uuid}/members/{member_user_id}")
async def update_member(
    workspace_uuid: str,
    member_user_id: int,
    body: MemberUpdateRequest,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Update a member's role in a workspace."""
    pool = await get_pool()
    async with acquire_connection(pool) as conn:
        ws_row = await conn.fetchrow(
            "SELECT id, create_uid FROM workspace WHERE uuid::text = $1 AND active = TRUE",
            workspace_uuid,
        )
        if not ws_row:
            raise HTTPException(status_code=404, detail="Workspace not found")
        if ws_row["create_uid"] != int(user.id):
            raise HTTPException(status_code=403, detail="Only workspace owners can update members")
        if member_user_id == ws_row["create_uid"]:
            raise HTTPException(status_code=400, detail="Cannot change owner's role")

        perms = ROLE_PERMS.get(body.role, ROLE_PERMS["viewer"])
        result = await conn.execute(
            """
            UPDATE workspace_share
            SET can_read = $1, can_write = $2, can_create = $3, can_delete = $4, can_comment = $5,
                write_uid = $6, write_date = NOW()
            WHERE workspace_id = $7 AND user_id = $8 AND active = TRUE
            """,
            perms["can_read"],
            perms["can_write"],
            perms["can_create"],
            perms["can_delete"],
            perms["can_comment"],
            int(user.id),
            ws_row["id"],
            member_user_id,
        )
        if result.split()[-1] == "0":
            raise HTTPException(status_code=404, detail="Member not found")
    return {"status": "ok", "role": body.role}


@router.delete("/{workspace_uuid}/members/{member_user_id}")
async def remove_member(
    workspace_uuid: str,
    member_user_id: int,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Remove a member from a workspace."""
    pool = await get_pool()
    async with acquire_connection(pool) as conn:
        ws_row = await conn.fetchrow(
            "SELECT id, create_uid FROM workspace WHERE uuid::text = $1 AND active = TRUE",
            workspace_uuid,
        )
        if not ws_row:
            raise HTTPException(status_code=404, detail="Workspace not found")
        if ws_row["create_uid"] != int(user.id):
            raise HTTPException(status_code=403, detail="Only workspace owners can remove members")
        if member_user_id == ws_row["create_uid"]:
            raise HTTPException(status_code=400, detail="Cannot remove owner")

        await conn.execute(
            "UPDATE workspace_share SET active = FALSE WHERE workspace_id = $1 AND user_id = $2",
            ws_row["id"],
            member_user_id,
        )
    invalidate_workspace_cache(member_user_id)
    return {"status": "ok"}


@router.delete("/{workspace_uuid}/pending-invites/{email}")
async def remove_pending_invite(
    workspace_uuid: str,
    email: str,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Cancel a pending invite by email."""
    pool = await get_pool()
    async with acquire_connection(pool) as conn:
        ws_row = await conn.fetchrow(
            "SELECT id, create_uid FROM workspace WHERE uuid::text = $1 AND active = TRUE",
            workspace_uuid,
        )
        if not ws_row:
            raise HTTPException(status_code=404, detail="Workspace not found")
        if ws_row["create_uid"] != int(user.id):
            raise HTTPException(status_code=403, detail="Only workspace owners can remove invites")

        await conn.execute(
            "UPDATE pending_invite SET active = FALSE WHERE workspace_id = $1 AND email = $2 AND node_id IS NULL",
            ws_row["id"],
            email,
        )
    return {"status": "ok"}
