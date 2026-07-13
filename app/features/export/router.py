"""Export router (feature-first).

Handles exporting nodes to various formats.
"""

import asyncio
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response

from app.db.connection import clear_request_conn, get_data_dir
from app.dependencies import (
    get_current_user,
    get_workspace_id,
    require_read_or_write_scope,
)
from app.export_jobs import create_job, get_job_for_user, update_job
from app.features.export.dependencies import _get_export_renderer, _make_export_repository
from app.features.export.models import (
    CreateExportJobResponse,
    ExportJobResponse,
    ExportRequest,
    RenderPdfRequest,
)
from app.features.export.service import ExportService
from app.logging_config import get_logger
from app.models import User

router = APIRouter(
    prefix="/export",
    tags=["Export"],
    dependencies=[Depends(get_current_user), Depends(require_read_or_write_scope)],
)
logger = get_logger(__name__)


def _validate_single_node_params(
    export_format: str,
    layout: str,
    properties: str,
    density: str,
    numbering: str,
    measure: str,
    doctype: str,
    link_style: str,
    theme_mode: str,
    page_size: str,
) -> None:
    """Validate query parameters for the single-node export endpoint."""
    if layout not in ("outline", "flat"):
        raise HTTPException(status_code=400, detail=f"Invalid layout: {layout}")
    if properties not in ("none", "main", "all"):
        raise HTTPException(status_code=400, detail=f"Invalid properties value: {properties}")
    if density not in ("comfortable", "compact"):
        raise HTTPException(status_code=400, detail=f"Invalid density: {density}")
    if numbering not in ("none", "hierarchical", "legal", "appendix"):
        raise HTTPException(status_code=400, detail=f"Invalid numbering: {numbering}")
    if measure not in ("full", "readable", "book", "two-column"):
        raise HTTPException(status_code=400, detail=f"Invalid measure: {measure}")
    if doctype not in ("none", "article", "report", "book", "legal", "academic"):
        raise HTTPException(status_code=400, detail=f"Invalid doctype: {doctype}")
    if link_style not in ("raw", "text"):
        raise HTTPException(status_code=400, detail=f"Invalid link_style: {link_style}")
    if theme_mode not in ("light", "dark"):
        raise HTTPException(status_code=400, detail=f"Invalid theme_mode: {theme_mode}")
    if page_size not in ("a4", "letter", "legal"):
        raise HTTPException(status_code=400, detail=f"Invalid page_size: {page_size}")


def _media_type_for_path(path: Path) -> str:
    """Return a suitable Content-Type for an export result file."""
    mapping = {
        ".md": "text/markdown",
        ".txt": "text/plain",
        ".json": "application/json",
        ".html": "text/html",
        ".pdf": "application/pdf",
    }
    return mapping.get(path.suffix.lower(), "application/octet-stream")


async def _run_node_export_job(job_uuid: str, user_id: str, export_args: dict) -> None:
    """Background task that performs the actual node export.

    Runs outside the request lifecycle and therefore must not capture any
    request-scoped dependencies. The workspace_id is passed explicitly and a
    fresh ExportRepository is built inside the task after clearing the request
    connection context.
    """
    clear_request_conn()

    try:
        update_job(job_uuid, status="running", status_text="Exporting nodes…")

        workspace_id = export_args.pop("workspace_id")
        user_id = export_args.pop("user_id")
        export_repo = await _make_export_repository(workspace_id)
        renderer = _get_export_renderer()
        service = ExportService(export_repo, renderer)
        content, filename, _mime_type = await service.export_nodes(
            workspace_id=workspace_id, user_id=user_id, **export_args
        )

        exports_dir = get_data_dir() / "exports"
        exports_dir.mkdir(parents=True, exist_ok=True)

        path = exports_dir / f"{job_uuid}_{filename}"
        if isinstance(content, str):
            content = content.encode("utf-8")
        path.write_bytes(content)

        update_job(
            job_uuid,
            status="completed",
            progress=100,
            result_path=str(path),
            status_text="Export complete",
        )
    except Exception as exc:
        logger.error(f"Node export job {job_uuid} failed: {exc}", exc_info=True)
        update_job(job_uuid, status="failed", error=str(exc))


@router.post("", response_model=CreateExportJobResponse)
async def export_nodes(
    request: ExportRequest,
    user: User = Depends(get_current_user),
    workspace_id: int = Depends(get_workspace_id),
):
    """Start an async job to export nodes to Markdown, HTML, PDF, Text, or JSON."""
    export_args = {
        "node_uuids": request.node_uuids,
        "format": request.format,
        "include_children": request.include_children,
        "layout": request.layout,
        "formatting": request.formatting,
        "style": request.style,
        "properties": request.properties,
        "density": request.density,
        "numbering": request.numbering,
        "measure": request.measure,
        "doctype": request.doctype,
        "section_break": request.section_break,
        "show_uuid": request.show_uuid,
        "link_style": request.link_style,
        "theme_mode": request.theme_mode,
        "cover_page": request.cover_page,
        "page_size": request.page_size,
        "include_child_pages": request.include_child_pages,
        "workspace_id": workspace_id,
        "user_id": int(user.id),
    }

    job = create_job(user_id=user.id, workspace_id=workspace_id)
    logger.info(
        f"Created node export job {job.id} for user {user.id} "
        f"(format={request.format}, nodes={len(request.node_uuids)})"
    )
    asyncio.create_task(_run_node_export_job(job.id, user.id, export_args))
    return CreateExportJobResponse(job_uuid=job.id)


@router.get("/jobs/{job_uuid}", response_model=ExportJobResponse)
async def get_node_export_job(job_uuid: str, user: User = Depends(get_current_user)):
    """Get the status of a node export job."""
    job = get_job_for_user(job_uuid, user.id)
    if job is None:
        raise HTTPException(status_code=404, detail="Export job not found")

    download_url = None
    if job.status == "completed" and job.result_path:
        download_url = f"/api/export/jobs/{job.id}/download"

    return ExportJobResponse(
        job_uuid=job.id,
        status=job.status,
        progress=job.progress,
        status_text=job.status_text,
        download_url=download_url,
        error=job.error,
    )


@router.get("/jobs/{job_uuid}/download")
async def download_node_export_job(job_uuid: str, user: User = Depends(get_current_user)):
    """Download the result of a completed export job."""
    job = get_job_for_user(job_uuid, user.id)
    if job is None:
        raise HTTPException(status_code=404, detail="Export job not found")
    if job.status != "completed":
        raise HTTPException(status_code=400, detail="Export job is not completed yet")
    if not job.result_path:
        raise HTTPException(status_code=500, detail="Export result missing")

    path = Path(job.result_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Export file no longer available")

    return FileResponse(path, filename=path.name, media_type=_media_type_for_path(path))


@router.get("/{node_uuid}", response_model=CreateExportJobResponse)
async def export_single_node(
    node_uuid: str,
    format: str = "markdown",
    include_children: bool = True,
    layout: str = "outline",
    formatting: bool = True,
    style: str | None = None,
    properties: str = "none",
    density: str = "comfortable",
    numbering: str = "none",
    measure: str = "full",
    doctype: str = "none",
    section_break: bool = False,
    show_uuid: bool = False,
    link_style: str = "raw",
    theme_mode: str = "light",
    cover_page: bool = False,
    page_size: str = "a4",
    include_child_pages: bool = False,
    user: User = Depends(get_current_user),
    workspace_id: int = Depends(get_workspace_id),
):
    """Start an async job to export a single node by UUID."""
    export_format = format
    _validate_single_node_params(
        export_format,
        layout,
        properties,
        density,
        numbering,
        measure,
        doctype,
        link_style,
        theme_mode,
        page_size,
    )

    export_args = {
        "node_uuids": [node_uuid],
        "format": export_format,
        "include_children": include_children,
        "layout": layout,
        "formatting": formatting,
        "style": style,
        "properties": properties,
        "density": density,
        "numbering": numbering,
        "measure": measure,
        "doctype": doctype,
        "section_break": section_break,
        "show_uuid": show_uuid,
        "link_style": link_style,
        "theme_mode": theme_mode,
        "cover_page": cover_page,
        "page_size": page_size,
        "include_child_pages": include_child_pages,
        "frontmatter": format.lower() == "markdown",
        "workspace_id": workspace_id,
        "user_id": int(user.id),
    }

    job = create_job(user_id=user.id, workspace_id=workspace_id)
    logger.info(
        f"Created node export job {job.id} for user {user.id} "
        f"(format={export_format}, node={node_uuid})"
    )
    asyncio.create_task(_run_node_export_job(job.id, user.id, export_args))
    return CreateExportJobResponse(job_uuid=job.id)


@router.post("/render-pdf")
async def render_pdf(request: RenderPdfRequest, user: User = Depends(get_current_user)):
    """Render an HTML string to a PDF using WeasyPrint.

    Falls back to returning the HTML with a Content-Type of text/html and a
    warning header when WeasyPrint is not installed, so callers can still
    present the content (e.g. let the browser print to PDF via Ctrl+P).
    """
    try:
        from weasyprint import HTML as WEASYPRINT_HTML

        # WeasyPrint is CPU-bound and can block the async event loop for large
        # documents. Run it in the default thread pool.
        loop = asyncio.get_event_loop()
        pdf_bytes = await loop.run_in_executor(
            None, lambda: WEASYPRINT_HTML(string=request.html).write_pdf()
        )
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": 'attachment; filename="export.pdf"'},
        )
    except ImportError:
        # WeasyPrint not installed — return the HTML so the client can use the
        # browser's built-in print-to-PDF as a fallback.
        return Response(
            content=request.html.encode("utf-8"),
            media_type="text/html; charset=utf-8",
            headers={
                "X-PDF-Fallback": "true",
                "X-PDF-Fallback-Reason": "WeasyPrint is not installed on this server. Use your browser's Print → Save as PDF to export.",
            },
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF rendering failed: {e}") from e
