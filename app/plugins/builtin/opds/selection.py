"""OPDS catalog selection: sources with downloadable attachments.

Mirrors the export-profiles selection semantics (Task 15): a catalog query is
either the default "all sources" AST or a saved-query reference, resolved
through the same :class:`WorkspaceExportServices` query engine. The
``has_asset()`` gate is the acquisition rule documented in
:func:`acquisition_attachments`; attachment-less sources are simply absent
from the catalog, never an error.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.plugins.builtin.export_profiles.services import WorkspaceExportServices
from app.plugins.core.export import ExportAttachment, ExportNodeContext

COVER_SCHEMA_UUID = SYSTEM_PROPERTY_UUIDS["cover"]

# Bound on how far the parent.cover fallback walks up the tree.
_COVER_FALLBACK_MAX_DEPTH = 32


def default_query() -> dict[str, Any]:
    """Default catalog selection: every node classed as ``source``."""
    return {
        "ast": {
            "type": "query",
            "version": "1.0",
            "scope": {"type": "scope", "scope_type": "entire_workspace"},
            "root_group": {
                "type": "group",
                "logic": "AND",
                "children": [
                    {
                        "type": "condition",
                        "condition_type": "class",
                        "class_uuid": SYSTEM_CLASS_UUIDS["source"],
                    }
                ],
            },
        }
    }


def acquisition_attachments(attachments: list[ExportAttachment]) -> list[ExportAttachment]:
    """Return the downloadable attachments of a source (the OPDS ``has_asset`` rule).

    An attachment is an acquisition candidate when its ``role`` selection is
    ``representation`` **or unset** — role is optional, so an unroled asset
    attached to a source is treated as its downloadable representation.
    Attachments with any other role (``cover``, ``supplement``, …) never
    produce acquisition links. A source with no acquisition candidates is
    excluded from the catalog.
    """
    return [
        attachment
        for attachment in attachments
        if attachment.role is None or attachment.role.lower() == "representation"
    ]


@dataclass
class CatalogEntry:
    """One publication in the OPDS catalog."""

    uuid: str
    title: str
    class_names: list[str] = field(default_factory=list)
    authors: list[str] = field(default_factory=list)
    isbn: str | None = None
    doi: str | None = None
    citekey: str | None = None
    publication_date: str | None = None
    acquisitions: list[ExportAttachment] = field(default_factory=list)
    cover: ExportAttachment | None = None

    @property
    def primary_class(self) -> str | None:
        """Most specific class name (drives the per-class navigation feeds)."""
        return self.class_names[0] if self.class_names else None


class CatalogBuilder:
    """Resolves a catalog query into entries over a WorkspaceStore."""

    def __init__(self, store: WorkspaceStore) -> None:
        self._store = store
        self._services = WorkspaceExportServices(store)

    async def entries_for_query(self, query: dict[str, Any]) -> list[CatalogEntry]:
        """Resolve the selection to entries; sources failing has_asset() drop out."""
        node_ids = await self._services.select_node_ids(query)
        contexts = await self._services.build_node_contexts(node_ids)
        entries: list[CatalogEntry] = []
        for context in contexts:
            acquisitions = acquisition_attachments(context.attachments)
            if not acquisitions:
                continue
            entries.append(
                CatalogEntry(
                    uuid=context.uuid,
                    title=context.title,
                    class_names=context.class_names,
                    authors=self._authors(context),
                    isbn=self._text_property(context, "isbn"),
                    doi=self._text_property(context, "doi"),
                    citekey=self._text_property(context, "citekey"),
                    publication_date=self._text_property(context, "publication_date"),
                    acquisitions=sorted(acquisitions, key=lambda a: a.asset_uuid),
                    cover=await self._resolve_cover(context),
                )
            )
        entries.sort(key=lambda e: (e.title.lower(), e.uuid))
        return entries

    @staticmethod
    def _authors(context: ExportNodeContext) -> list[str]:
        """Author display names (agent refs already resolved by the services)."""
        names = context.properties.get("authors")
        if isinstance(names, list):
            return [str(name) for name in names if name]
        author = context.properties.get("author")
        return [str(author)] if author else []

    @staticmethod
    def _text_property(context: ExportNodeContext, name: str) -> str | None:
        value = context.properties.get(name)
        if value is None or isinstance(value, list):
            return None
        text = str(value).strip()
        return text or None

    async def _resolve_cover(self, context: ExportNodeContext) -> ExportAttachment | None:
        """Cover resolution: ``cover`` property (parent fallback), then role=cover.

        The ``cover`` property is the canonical pointer (Decision 28): an
        edition with no cover inherits its work's. When neither yields an
        existing asset, a ``role=cover`` attachment is the secondary source.
        """
        cover_uuid = await self._cover_property_with_fallback(context.uuid)
        if cover_uuid is not None:
            metadata = await self._services.get_asset_metadata(cover_uuid)
            if metadata is not None:
                return metadata
        for attachment in context.attachments:
            if (attachment.role or "").lower() == "cover":
                return attachment
        return None

    async def _cover_property_with_fallback(self, node_uuid: str) -> str | None:
        """Walk up the parent chain until a ``cover`` property value is found."""
        current: str | None = node_uuid
        for _ in range(_COVER_FALLBACK_MAX_DEPTH):
            if current is None:
                return None
            rows = await self._store.query(
                "SELECT value FROM property_value "
                "WHERE node_id = ? AND property_schema_id = ? ORDER BY idx LIMIT 1",
                (current, COVER_SCHEMA_UUID),
            )
            if rows:
                try:
                    value = json.loads(rows[0]["value"])
                except (ValueError, TypeError):
                    value = None
                if isinstance(value, str) and value:
                    return value
            parent_rows = await self._store.query(
                "SELECT parent_id FROM node WHERE id = ?", (current,)
            )
            if not parent_rows:
                return None
            current = parent_rows[0]["parent_id"]
        return None
