"""Zotero sync source implementation.

Zotero items land on the system source tree: item types map to the system
classes (``book``/``paper``/``article``/``thesis``/``document``/``movie``/
``weblink``), creators become find-or-create ``person``/``organization``
agent nodes referenced from the ``authors`` property, and DOI/date/URL/ISBN/
publisher/tags land in the system properties. The ``citekey`` property is
filled only when empty — Zotero's own citation key wins, otherwise the key is
generated from the workspace ``citekey_pattern`` setting; stored keys are
never recomputed or overwritten.
"""

from __future__ import annotations

from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.plugins.core.agents import find_or_create_creators
from app.plugins.core.citekey import fill_citekey_if_empty
from app.plugins.core.ports import (
    SyncContext,
    SyncResult,
    SyncSource,
)

from .client import ZoteroClient, ZoteroItem

# Zotero itemType → system class name. Anything unmapped lands on the
# generic ``document`` class.
ITEM_TYPE_CLASS_NAMES: dict[str, str] = {
    "book": "book",
    "bookSection": "book",
    "journalArticle": "paper",
    "conferencePaper": "paper",
    "preprint": "paper",
    "magazineArticle": "article",
    "newspaperArticle": "article",
    "thesis": "thesis",
    "film": "movie",
    "videoRecording": "movie",
    "webpage": "weblink",
}
DEFAULT_CLASS_NAME = "document"


def normalize_creators(creators: list[dict[str, str]]) -> list[dict[str, str]]:
    """Normalize Zotero creators to the shared person/organization shape."""
    normalized: list[dict[str, str]] = []
    for creator in creators:
        single_field = creator.get("name", "").strip()
        if single_field:
            normalized.append({"organization_name": single_field})
            continue
        given = creator.get("firstName", "").strip()
        family = creator.get("lastName", "").strip()
        if given or family:
            normalized.append({"given_name": given, "family_name": family})
    return normalized


def item_class_uuid(item: ZoteroItem) -> str:
    """Map a Zotero item type to its system class UUID."""
    class_name = ITEM_TYPE_CLASS_NAMES.get(item.item_type, DEFAULT_CLASS_NAME)
    return SYSTEM_CLASS_UUIDS[class_name]


class ZoteroSyncSource(SyncSource):
    """Pull Zotero items into Notees as nodes."""

    id = "zotero.library"
    label = "Zotero library"

    async def sync(self, context: SyncContext) -> SyncResult:
        result = SyncResult()
        plugin_ctx = context.plugin_context

        workspace_uuid = context.workspace_uuid or str(context.workspace_id)
        actor_uuid = context.actor_uuid or str(context.user_id)

        api_url = await plugin_ctx.get_setting(
            context.workspace_id, context.user_id, "api_url", "http://127.0.0.1:23119/"
        )
        library_type = await plugin_ctx.get_setting(
            context.workspace_id, context.user_id, "library_type", "users"
        )
        library_id = await plugin_ctx.get_setting(
            context.workspace_id, context.user_id, "library_id", ""
        )

        if not library_id:
            result.messages.append("Zotero library ID is not configured")
            return result

        client = ZoteroClient(
            base_url=api_url,
            library_type=library_type,
            library_id=library_id,
        )

        try:
            items = await client.fetch_items(limit=100)
        except Exception as exc:  # noqa: BLE001
            result.messages.append(f"Failed to fetch Zotero items: {exc}")
            return result

        zotero_key_schema_uuid = await plugin_ctx.ensure_property_schema(
            workspace_uuid,
            actor_uuid,
            "Zotero Key",
            icon="identifier",
        )

        synced = 0
        skipped = 0
        for item in items:
            name = item.title or (f"@{item.citekey}" if item.citekey else "")
            if not name:
                skipped += 1
                continue

            property_values: dict[str, str] = {}
            if item.doi:
                property_values[SYSTEM_PROPERTY_UUIDS["doi"]] = item.doi
            if item.date:
                property_values[SYSTEM_PROPERTY_UUIDS["publication_date"]] = item.date
            if item.url:
                property_values[SYSTEM_PROPERTY_UUIDS["url"]] = item.url
            if item.isbn:
                property_values[SYSTEM_PROPERTY_UUIDS["isbn"]] = item.isbn
            if item.publisher:
                property_values[SYSTEM_PROPERTY_UUIDS["publisher"]] = item.publisher

            node_uuid = await plugin_ctx.upsert_page_by_external_id(
                workspace_uuid,
                actor_uuid,
                external_id=item.key,
                external_id_schema_uuid=zotero_key_schema_uuid,
                name=name,
                class_uuids=[item_class_uuid(item)],
                property_values=property_values,
                icon="bookshelf",
            )
            if node_uuid not in result.created_node_ids:
                result.created_node_ids.append(node_uuid)

            if item.tags:
                await plugin_ctx.set_multi_property(
                    workspace_uuid,
                    actor_uuid,
                    node_uuid,
                    SYSTEM_PROPERTY_UUIDS["tags"],
                    item.tags,
                )

            creators = normalize_creators(item.creators)
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
                title=item.title,
                creators=creators,
                publication_date=item.date,
                explicit_citekey=item.citekey,
            )
            synced += 1

        result.messages.append(f"Synced {synced} Zotero items")
        if skipped:
            result.messages.append(f"Skipped {skipped} items without title or citekey")
        return result
