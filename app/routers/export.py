"""Export router (refactored).

Handles exporting nodes to various formats.
Uses domain types where applicable.
"""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from ..models import ExportFormat, ExportRequest, User
from ..node_export import export_nodes as _run_export
from .auth import get_current_user

router = APIRouter(prefix="/export", tags=["Export"])


class RenderPdfRequest(BaseModel):
    html: str


@router.post("")
async def export_nodes(request: ExportRequest, user: User = Depends(get_current_user)):
    """Export nodes to Markdown, HTML, or PDF."""
    try:
        content, filename, mime_type = await _run_export(
            user.id,
            node_ids=request.node_ids,
            format=request.format,
            include_children=request.include_children,
            layout=request.layout,
            formatting=request.formatting,
            style=request.style,
            properties=request.properties,
            density=request.density,
            numbering=request.numbering,
            measure=request.measure,
            doctype=request.doctype,
            section_break=request.section_break,
            show_uuid=request.show_uuid,
            link_style=request.link_style,
            theme_mode=request.theme_mode,
            cover_page=request.cover_page,
        )

        return Response(
            content=content, media_type=mime_type, headers={"Content-Disposition": f'attachment; filename="{filename}"'}
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/{node_uuid}")
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
    user: User = Depends(get_current_user),
):
    """Export a single node by UUID."""
    try:
        export_format = ExportFormat(format)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid format: {format}") from None

    if export_format in (ExportFormat.TEXT, ExportFormat.JSON):
        # Text and JSON don't support layout/style/density/etc. options
        # but we still pass them through; the converter ignores irrelevant ones.
        pass

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

    # cover_page is a boolean flag, no validation needed

    try:
        content, filename, mime_type = await _run_export(
            user.id,
            node_ids=[node_uuid],
            format=export_format,
            include_children=include_children,
            layout=layout,
            formatting=formatting,
            style=style,
            properties=properties,
            density=density,
            numbering=numbering,
            measure=measure,
            doctype=doctype,
            section_break=section_break,
            show_uuid=show_uuid,
            link_style=link_style,
            theme_mode=theme_mode,
            cover_page=cover_page,
            frontmatter=export_format == ExportFormat.MARKDOWN,
        )

        return Response(
            content=content, media_type=mime_type, headers={"Content-Disposition": f'attachment; filename="{filename}"'}
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/render-pdf")
async def render_pdf(request: RenderPdfRequest, user: User = Depends(get_current_user)):
    """Render an HTML string to a PDF using WeasyPrint.

    Falls back to returning the HTML with a Content-Type of text/html and a
    warning header when WeasyPrint is not installed, so callers can still
    present the content (e.g. let the browser print to PDF via Ctrl+P).
    """
    try:
        from weasyprint import HTML as WEASYPRINT_HTML

        pdf_bytes = WEASYPRINT_HTML(string=request.html).write_pdf()
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
