"""Auto-export router for Notees.

Handles automatic export of pages to Markdown files on save,
and batch re-export for force recreation.

Export format:
- Flat folder with UUID filenames: {uuid}.md
- YAML frontmatter with title, parents, tags, classes, properties
- Body uses existing stringify_ast PLAIN_MARKDOWN output
"""

from __future__ import annotations

import asyncio
import io
import zipfile
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.db.connection import clear_request_conn, get_workspace_dir, get_workspace_uuid
from app.dependencies import (
    get_current_user,
    get_workspace_id,
    require_read_or_write_scope,
    require_write_scope,
)
from app.features.export.auto_export_service import AutoExportService
from app.features.export.dependencies import _make_export_repository, get_export_repository
from app.features.export.port import ExportRepository
from app.features.export.service import ExportService
from app.features.workspaces.manager import _active_workspaces, _get_numeric_user_id
from app.infrastructure.export.renderer import HtmlPdfExportRenderer
from app.logging_config import get_logger
from app.models import User

logger = get_logger(__name__)

router = APIRouter(
    prefix="/auto-export",
    tags=["Auto Export"],
    dependencies=[Depends(get_current_user), Depends(require_read_or_write_scope)],
)

# ---------------------------------------------------------------------------
# In-memory export progress tracking (single-process only)
# ---------------------------------------------------------------------------


class BatchExportStatus(BaseModel):
    running: bool
    total: int
    completed: int
    current_page: str | None
    error: str | None


_batch_status: dict[str, BatchExportStatus] = {}
_status_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# Service builder
# ---------------------------------------------------------------------------


def _build_auto_export_service(
    workspace_id: int,
    workspace_uuid: str,
    export_repo: ExportRepository,
) -> AutoExportService:
    """Build an AutoExportService for the given workspace."""
    export_service = ExportService(export_repo, HtmlPdfExportRenderer())
    export_dir = get_workspace_dir(workspace_uuid) / "markdown-export"
    export_dir.mkdir(parents=True, exist_ok=True)
    return AutoExportService(
        workspace_id=workspace_id,
        workspace_uuid=workspace_uuid,
        node_export_service=export_service,
        export_dir=export_dir,
        renderer=HtmlPdfExportRenderer(),
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


class BatchExportRequest(BaseModel):
    pass


@router.post("/batch", dependencies=[Depends(require_write_scope)])
async def auto_export_batch(
    _request: BatchExportRequest,
    user: User = Depends(get_current_user),
    export_repo: ExportRepository = Depends(get_export_repository),
    workspace_id: int = Depends(get_workspace_id),
):
    """Force re-export of all pages in the workspace to markdown.

    This is a dev/heavy operation that runs asynchronously and reports progress
    via the /status endpoint.
    """
    numeric_user_id = await _get_numeric_user_id(user.id)
    if not numeric_user_id:
        raise HTTPException(status_code=404, detail="User not found")

    active_uuid = _active_workspaces.get(user.id)

    workspace_uuid = await get_workspace_uuid(workspace_id)
    if not workspace_uuid:
        workspace_uuid = active_uuid

    if not workspace_uuid:
        raise HTTPException(status_code=400, detail="No active workspace")

    status_key = f"{user.id}:{workspace_uuid}"

    async with _status_lock:
        if _batch_status.get(
            status_key, BatchExportStatus(running=False, total=0, completed=0, current_page=None, error=None)
        ).running:
            raise HTTPException(status_code=409, detail="Batch export already in progress")

        _batch_status[status_key] = BatchExportStatus(running=True, total=0, completed=0, current_page=None, error=None)

    # Start the batch export in the background. The export repository is
    # reconstructed inside the task after clearing the request connection.
    asyncio.create_task(_run_batch_export(workspace_id, workspace_uuid, status_key))

    return {"status": "started"}


async def _run_batch_export(
    workspace_id: int,
    workspace_uuid: str,
    status_key: str,
):
    """Background task that exports all pages sequentially."""
    # Background tasks inherit the parent request's context variables,
    # including the request-scoped DB connection. Clear it so we don't
    # race with the middleware releasing the connection back to the pool.
    clear_request_conn()
    try:
        export_repo = await _make_export_repository(workspace_id)
        service = _build_auto_export_service(workspace_id, workspace_uuid, export_repo)

        rows = await export_repo.list_exportable_pages(workspace_id)

        page_uuids = [r["uuid"] for r in rows]
        total = len(page_uuids)

        async with _status_lock:
            _batch_status[status_key] = BatchExportStatus(
                running=True, total=total, completed=0, current_page=None, error=None
            )

        service.clear_exports()

        for i, node_uuid in enumerate(page_uuids):
            title = AutoExportService.extract_page_title(rows[i]["name"])
            async with _status_lock:
                _batch_status[status_key] = BatchExportStatus(
                    running=True, total=total, completed=i, current_page=title, error=None
                )
            try:
                await service.write_page_markdown(node_uuid)
            except Exception as e:
                logger.error(f"Batch export failed for page {node_uuid}: {e}")
                # Continue with other pages, record error at end

        async with _status_lock:
            _batch_status[status_key] = BatchExportStatus(
                running=False, total=total, completed=total, current_page=None, error=None
            )

    except Exception as e:
        logger.error(f"Batch export failed: {e}")
        async with _status_lock:
            _batch_status[status_key] = BatchExportStatus(
                running=False, total=0, completed=0, current_page=None, error=str(e)
            )


@router.post("/{node_uuid}", dependencies=[Depends(require_write_scope)])
async def auto_export_page(
    node_uuid: str,
    user: User = Depends(get_current_user),
    export_repo: ExportRepository = Depends(get_export_repository),
    workspace_id: int = Depends(get_workspace_id),
):
    """Export a single page to the workspace markdown-export directory."""
    numeric_user_id = await _get_numeric_user_id(user.id)
    if not numeric_user_id:
        raise HTTPException(status_code=404, detail="User not found")

    active_uuid = _active_workspaces.get(user.id)

    workspace_uuid = await get_workspace_uuid(workspace_id)
    if not workspace_uuid:
        workspace_uuid = active_uuid

    if not workspace_uuid:
        raise HTTPException(status_code=400, detail="No active workspace")

    service = _build_auto_export_service(workspace_id, workspace_uuid, export_repo)

    try:
        filename = await service.write_page_markdown(node_uuid)
    except ValueError as e:
        logger.warning(f"Auto-export failed for {node_uuid}: {e}")
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.error(f"Auto-export error for {node_uuid}: {e}")
        raise HTTPException(status_code=500, detail=f"Export failed: {e}") from e

    return {"filename": filename, "path": str(service.export_dir / filename)}


@router.get("/status")
async def auto_export_status(
    user: User = Depends(get_current_user),
):
    """Get the current batch export status."""
    active_uuid = _active_workspaces.get(user.id)
    if not active_uuid:
        return BatchExportStatus(running=False, total=0, completed=0, current_page=None, error=None)

    status_key = f"{user.id}:{active_uuid}"
    async with _status_lock:
        return _batch_status.get(
            status_key,
            BatchExportStatus(running=False, total=0, completed=0, current_page=None, error=None),
        )


@router.get("/download")
async def auto_export_download(
    user: User = Depends(get_current_user),
    export_repo: ExportRepository = Depends(get_export_repository),
    workspace_id: int = Depends(get_workspace_id),
):
    """Download all exported markdown files as a ZIP archive."""
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if not workspace_uuid:
        raise HTTPException(status_code=404, detail="Workspace not found")

    service = _build_auto_export_service(workspace_id, workspace_uuid, export_repo)
    md_files = sorted(service.export_dir.glob("*.md"))

    if not md_files:
        raise HTTPException(status_code=404, detail="No exported markdown files found")

    workspace_name = "workspace"  # Name is not critical for the archive filename
    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    safe_name = workspace_name.replace(" ", "_").replace("/", "_")
    zip_filename = f"{safe_name}-md-{timestamp}.zip"

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for md_file in md_files:
            zf.write(md_file, md_file.name)
    buffer.seek(0)

    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{zip_filename}"',
        },
    )
