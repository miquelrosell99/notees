"""Zotero sync source implementation."""

from __future__ import annotations

from app.plugins.core.ports import (
    SyncContext,
    SyncResult,
    SyncSource,
)

from .client import ZoteroClient


class ZoteroSyncSource(SyncSource):
    """Pull Zotero items into Notees as nodes."""

    id = "zotero.library"
    label = "Zotero library"

    async def sync(self, context: SyncContext) -> SyncResult:
        result = SyncResult()
        plugin_ctx = context.plugin_context

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

        source_class_id = await plugin_ctx.ensure_class(
            context.workspace_id,
            context.user_id,
            "Source",
            icon="book-open-variant",
        )
        zotero_key_prop_id = await plugin_ctx.ensure_property(
            context.workspace_id,
            context.user_id,
            "Zotero Key",
            icon="identifier",
        )

        synced = 0
        skipped = 0
        for item in items:
            citekey = item.citekey
            if not citekey:
                skipped += 1
                continue

            name = f"@{citekey}"
            node = await plugin_ctx.upsert_page_by_external_id(
                context.workspace_id,
                context.user_id,
                external_id=item.key,
                external_id_property_id=zotero_key_prop_id,
                name=name,
                class_ids=[source_class_id],
                icon="bookshelf",
            )
            if node.id is not None and node.id not in result.created_node_ids:
                result.created_node_ids.append(node.id)
            synced += 1

        result.messages.append(f"Synced {synced} Zotero items")
        if skipped:
            result.messages.append(f"Skipped {skipped} items without a citekey")
        return result
