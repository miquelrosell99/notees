"""BibTeX importer adapter."""

from __future__ import annotations

from app.plugins.core.ports import (
    ImportContext,
    ImporterAdapter,
    ImportResult,
)

from .parser import parse_bibtex


class BibTeXImporter(ImporterAdapter):
    """Import BibTeX files into Notees nodes."""

    id = "bibtex.file"
    label = "BibTeX file"
    file_extensions = ["bib"]

    async def import_data(
        self,
        payload: bytes,
        _content_type: str | None,
        context: ImportContext,
    ) -> ImportResult:
        result = ImportResult()
        plugin_ctx = context.plugin_context
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError:
            result.messages.append("File is not valid UTF-8")
            return result

        entries = parse_bibtex(text)
        if not entries:
            result.messages.append("No BibTeX entries found")
            return result

        source_class_uuid = await plugin_ctx.ensure_class(
            context.workspace_uuid or str(context.workspace_id),
            context.actor_uuid or str(context.user_id),
            "Source: BibTeX",
            icon="file-document-outline",
        )

        for entry in entries:
            name = entry.title or entry.cite_key
            node_uuid = await plugin_ctx.create_page(
                context.workspace_uuid or str(context.workspace_id),
                context.actor_uuid or str(context.user_id),
                name,
                class_uuids=[source_class_uuid],
            )
            result.created_node_ids.append(node_uuid)

        result.messages.append(f"Imported {len(entries)} BibTeX entries")
        return result
