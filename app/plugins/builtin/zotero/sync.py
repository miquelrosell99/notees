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

        source_class_uuid = await plugin_ctx.ensure_class(
            workspace_uuid,
            actor_uuid,
            "Source",
            icon="book-open-variant",
        )
        zotero_key_schema_uuid = await plugin_ctx.ensure_property_schema(
            workspace_uuid,
            actor_uuid,
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
            node_uuid = await plugin_ctx.upsert_page_by_external_id(
                workspace_uuid,
                actor_uuid,
                external_id=item.key,
                external_id_schema_uuid=zotero_key_schema_uuid,
                name=name,
                class_uuids=[source_class_uuid],
                icon="bookshelf",
            )
            if node_uuid not in result.created_node_ids:
                result.created_node_ids.append(node_uuid)
            synced += 1

        result.messages.append(f"Synced {synced} Zotero items")
        if skipped:
            result.messages.append(f"Skipped {skipped} items without a citekey")
        return result
