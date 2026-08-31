"""BibTeX importer adapter.

Entries land on the system source tree: entry types map to the system
classes (``book``/``paper``/``thesis``/``document``), authors become
find-or-create ``person`` agent nodes referenced from the ``authors``
property, and DOI/date/URL/ISBN/publisher land in the system properties. The
entry key becomes the ``citekey`` — stored only when the node's citekey is
empty, never recomputed or overwritten. Entries are upserted by their BibTeX
key so re-importing the same file does not create duplicates.
"""

from __future__ import annotations

from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.plugins.core.agents import find_or_create_creators
from app.plugins.core.citekey import fill_citekey_if_empty
from app.plugins.core.ports import (
    ImportContext,
    ImporterAdapter,
    ImportResult,
)

from .parser import BibEntry, parse_authors, parse_bibtex

# BibTeX entry type → system class name. Anything unmapped (``misc``,
# ``techreport``, ``manual``, ``booklet``, ``proceedings``, …) lands on the
# generic ``document`` class.
ENTRY_TYPE_CLASS_NAMES: dict[str, str] = {
    "book": "book",
    "inbook": "book",
    "incollection": "book",
    "article": "paper",
    "inproceedings": "paper",
    "conference": "paper",
    "phdthesis": "thesis",
    "mastersthesis": "thesis",
}
DEFAULT_CLASS_NAME = "document"


def entry_class_uuid(entry: BibEntry) -> str:
    """Map a BibTeX entry type to its system class UUID."""
    class_name = ENTRY_TYPE_CLASS_NAMES.get(entry.entry_type, DEFAULT_CLASS_NAME)
    return SYSTEM_CLASS_UUIDS[class_name]


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

        workspace_uuid = context.workspace_uuid or str(context.workspace_id)
        actor_uuid = context.actor_uuid or str(context.user_id)

        bibtex_key_schema_uuid = await plugin_ctx.ensure_property_schema(
            workspace_uuid,
            actor_uuid,
            "BibTeX Key",
            icon="identifier",
        )

        for entry in entries:
            name = entry.title or entry.cite_key

            property_values: dict[str, str] = {}
            if entry.doi:
                property_values[SYSTEM_PROPERTY_UUIDS["doi"]] = entry.doi
            if entry.publication_date:
                property_values[SYSTEM_PROPERTY_UUIDS["publication_date"]] = (
                    entry.publication_date
                )
            if entry.url:
                property_values[SYSTEM_PROPERTY_UUIDS["url"]] = entry.url
            if entry.isbn:
                property_values[SYSTEM_PROPERTY_UUIDS["isbn"]] = entry.isbn
            if entry.publisher:
                property_values[SYSTEM_PROPERTY_UUIDS["publisher"]] = entry.publisher

            node_uuid = await plugin_ctx.upsert_page_by_external_id(
                workspace_uuid,
                actor_uuid,
                external_id=entry.cite_key,
                external_id_schema_uuid=bibtex_key_schema_uuid,
                name=name,
                class_uuids=[entry_class_uuid(entry)],
                property_values=property_values,
                icon="file-document-outline",
            )
            if node_uuid not in result.created_node_ids:
                result.created_node_ids.append(node_uuid)

            creators = parse_authors(entry.author)
            if creators:
                author_uuids = await find_or_create_creators(
                    plugin_ctx, workspace_uuid, actor_uuid, creators
                )
                if author_uuids:
                    await plugin_ctx.set_multi_property(
                        workspace_uuid,
                        actor_uuid,
                        node_uuid,
                        SYSTEM_PROPERTY_UUIDS["authors"],
                        author_uuids,
                    )

            await fill_citekey_if_empty(
                plugin_ctx,
                workspace_uuid=workspace_uuid,
                actor_uuid=actor_uuid,
                workspace_id=context.workspace_id,
                user_id=context.user_id,
                node_uuid=node_uuid,
                title=entry.title,
                creators=creators,
                publication_date=entry.publication_date,
                explicit_citekey=entry.cite_key,
            )

        result.messages.append(f"Imported {len(entries)} BibTeX entries")
        return result
