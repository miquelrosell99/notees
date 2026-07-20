"""Auto-export service for Notees.

Encapsulates Markdown/YAML export writer logic and file I/O for automatic
exports. The router remains a thin HTTP adapter.
"""

from __future__ import annotations

from pathlib import Path

from app.domain.ports import NodeExportRenderer
from app.domain.stringify_ast import StringifyMode, StringifyOptions, parse_ast, stringify_ast
from app.features.export.service import ExportService


def _extract_page_title(name: str | None) -> str:
    """Extract plain text title from a node's name (AST JSON or plain text)."""
    if not name:
        return "untitled"
    try:
        ast = parse_ast(name)
        opts = StringifyOptions(mode=StringifyMode.TEXT_ONLY)
        return stringify_ast(ast, opts) or "untitled"
    except (ValueError, TypeError):
        return name.strip() or "untitled"


class AutoExportService:
    """Service that writes auto-export Markdown files with YAML frontmatter."""

    def __init__(
        self,
        workspace_id: int,
        workspace_uuid: str,
        node_export_service: ExportService,
        export_dir: Path,
        renderer: NodeExportRenderer,
    ):
        self._workspace_id = workspace_id
        self._workspace_uuid = workspace_uuid
        self._node_export_service = node_export_service
        self._export_dir = export_dir
        self._renderer = renderer

    @property
    def export_dir(self) -> Path:
        """Return the markdown export directory."""
        return self._export_dir

    def clear_exports(self) -> None:
        """Remove all existing .md files from the export directory."""
        for existing in self._export_dir.glob("*.md"):
            existing.unlink()

    @staticmethod
    def extract_page_title(name: str | None) -> str:
        """Extract plain text title from a node's name."""
        return _extract_page_title(name)

    async def write_page_markdown(self, node_uuid: str) -> str:
        """Export a single page to markdown and write it to the export directory.

        Returns the filename written.
        """
        content_bytes, _filename, _mime = await self._node_export_service.export_nodes(
            workspace_uuid=self._workspace_uuid,
            node_uuids=[node_uuid],
            format="markdown",
            include_children=True,
            layout="outline",
            formatting=True,
            properties="none",
            link_style="raw",
        )
        body = content_bytes.decode("utf-8")

        metadata = await self._node_export_service.get_auto_export_metadata(
            self._workspace_uuid, node_uuid
        )
        frontmatter = self._renderer.build_yaml_frontmatter(metadata)
        full_content = frontmatter + body

        filename = f"{node_uuid}.md"
        file_path = self._export_dir / filename
        file_path.write_text(full_content, encoding="utf-8")
        return filename
