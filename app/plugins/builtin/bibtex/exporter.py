"""BibTeX exporter adapter."""

from __future__ import annotations

from app.plugins.core.ports import (
    ExportContext,
    ExporterAdapter,
    ExportResult,
)

from .parser import BibEntry, serialize_bibtex


class BibTeXExporter(ExporterAdapter):
    """Export selected Notees nodes to BibTeX."""

    format_id = "bibtex"
    label = "BibTeX"
    extension = "bib"
    mime_type = "application/x-bibtex"

    async def export_nodes(self, context: ExportContext) -> ExportResult:
        # TODO: read nodes and build BibEntry objects once plugin settings storage
        # and class lookup are wired in.
        entries: list[BibEntry] = []
        content = serialize_bibtex(entries)
        return ExportResult(
            content=content.encode("utf-8"),
            filename="notees.bib",
            mime_type=self.mime_type,
        )
