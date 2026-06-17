"""Export router (refactored).

Handles exporting nodes to various formats.
Uses domain types where applicable.
"""

import asyncio
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from ..db.connection import clear_request_conn, get_data_dir
from ..dependencies import get_current_user
from ..export_jobs import create_job, get_job, update_job
from ..logging_config import get_logger
from ..models import ExportFormat, ExportRequest, User
from ..node_export import export_nodes as _run_export

router = APIRouter(prefix="/export", tags=["Export"])
logger = get_logger(__name__)


class RenderPdfRequest(BaseModel):
    html: str


class CreateExportJobResponse(BaseModel):
    job_id: str


class ExportJobResponse(BaseModel):
    id: str
    status: str
    progress: int
    status_text: str
    download_url: str | None = None
    error: str | None = None


def _validate_single_node_params(
    export_format: ExportFormat,
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


async def _run_node_export_job(job_id: str, user_id: str, export_args: dict) -> None:
    """Background task that performs the actual node export.

    Runs outside the request lifecycle and therefore must not capture any
    request-scoped dependencies. It builds a fresh User object and relies on
    the module-level export helper to acquire its own database connections.
    """
    clear_request_conn()

    try:
        update_job(job_id, status="running", status_text="Exporting nodes…")

        # Construct a minimal valid User so the export runs under the right
        # identity without inheriting request-scoped state.
        user = User(
            id=user_id,
            email="",
            uuid=str(uuid4()),
            created_at=datetime.now(UTC),
        )
        content, filename, _mime_type = await _run_export(user.id, **export_args)

        exports_dir = get_data_dir() / "exports"
        exports_dir.mkdir(parents=True, exist_ok=True)

        path = exports_dir / f"{job_id}_{filename}"
        if isinstance(content, str):
            content = content.encode("utf-8")
        path.write_bytes(content)

        update_job(
            job_id,
            status="completed",
            progress=100,
            result_path=str(path),
            status_text="Export complete",
        )
    except Exception as exc:
        logger.error(f"Node export job {job_id} failed: {exc}", exc_info=True)
        update_job(job_id, status="failed", error=str(exc))


@router.post("", response_model=CreateExportJobResponse)
async def export_nodes(request: ExportRequest, user: User = Depends(get_current_user)):
    """Start an async job to export nodes to Markdown, HTML, PDF, Text, or JSON."""
    export_args = {
        "node_ids": request.node_ids,
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
    }

    job = create_job()
    logger.info(
        f"Created node export job {job.id} for user {user.id} "
        f"(format={request.format}, nodes={len(request.node_ids)})"
    )
    asyncio.create_task(_run_node_export_job(job.id, user.id, export_args))
    return CreateExportJobResponse(job_id=job.id)


@router.get("/jobs/{job_id}", response_model=ExportJobResponse)
async def get_node_export_job(job_id: str, user: User = Depends(get_current_user)):
    """Get the status of a node export job."""
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Export job not found")

    download_url = None
    if job.status == "completed" and job.result_path:
        download_url = f"/api/export/jobs/{job.id}/download"

    return ExportJobResponse(
        id=job.id,
        status=job.status,
        progress=job.progress,
        status_text=job.status_text,
        download_url=download_url,
        error=job.error,
    )


@router.get("/jobs/{job_id}/download")
async def download_node_export_job(job_id: str, user: User = Depends(get_current_user)):
    """Download the result of a completed node export job."""
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
):
    """Start an async job to export a single node by UUID."""
    try:
        export_format = ExportFormat(format)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid format: {format}") from None

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
        "node_ids": [node_uuid],
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
        "frontmatter": export_format == ExportFormat.MARKDOWN,
    }

    job = create_job()
    logger.info(
        f"Created node export job {job.id} for user {user.id} "
        f"(format={export_format}, node={node_uuid})"
    )
    asyncio.create_task(_run_node_export_job(job.id, user.id, export_args))
    return CreateExportJobResponse(job_id=job.id)


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
