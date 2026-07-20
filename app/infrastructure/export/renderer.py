"""Concrete node export renderer adapter."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ...domain.ports import NodeExportRenderer
from .pdf import render_pdf
from .rendering import export_to_html
from .share_files import delete_share_html, get_static_share_path
from .yaml_frontmatter import build_yaml_frontmatter


class HtmlPdfExportRenderer(NodeExportRenderer):
    """Renderer adapter that delegates to the export rendering modules."""

    async def render_html(
        self,
        nodes: list[Any],
        resolver: Any,
        layout: str,
        formatting: bool,
        style: str | None,
        properties_data: dict[str, list] | None,
        density: str,
        numbering: str,
        measure: str,
        doctype: str,
        section_break: bool,
        strip_link_syntax: bool,
        code_class_id: str | None,
        quote_class_id: str | None,
        callout_class_map: dict[str, str] | None,
        theme_mode: str,
        cover_page: bool,
        page_size: str,
        cover_metadata: dict[str, Any] | None,
    ) -> str:
        """Render nodes to a complete HTML document string."""
        return export_to_html(
            nodes=nodes,
            resolver=resolver,
            layout=layout,
            formatting=formatting,
            style=style,
            properties_data=properties_data,
            density=density,
            numbering=numbering,
            measure=measure,
            doctype=doctype,
            section_break=section_break,
            strip_link_syntax=strip_link_syntax,
            code_class_id=code_class_id,
            quote_class_id=quote_class_id,
            callout_class_map=callout_class_map,
            theme_mode=theme_mode,
            cover_page=cover_page,
            page_size=page_size,
            cover_metadata=cover_metadata,
        )

    async def render_pdf(self, html_content: str, page_size: str) -> bytes:
        """Render an HTML string to a PDF document."""
        return render_pdf(html_content, page_size)

    def build_yaml_frontmatter(self, metadata: dict[str, Any]) -> str:
        """Build a YAML frontmatter block from metadata."""
        return build_yaml_frontmatter(metadata)

    def static_share_path(self, share_uuid: str) -> Path:
        """Return the filesystem path for a static share HTML file."""
        return get_static_share_path(share_uuid)

    def delete_share_html(self, share_uuid: str) -> None:
        """Delete the static HTML file for a share, if it exists."""
        delete_share_html(share_uuid)
