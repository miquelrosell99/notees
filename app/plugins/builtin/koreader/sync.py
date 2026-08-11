"""KOReader sync source implementation."""

from __future__ import annotations

from app.plugins.core.ports import (
    SyncContext,
    SyncResult,
    SyncSource,
)

from .client import KOReaderClient


class KOReaderSyncSource(SyncSource):
    """Pull KOReader highlights into Notees as nodes."""

    id = "koreader.highlights"
    label = "KOReader highlights"

    async def sync(self, context: SyncContext) -> SyncResult:
        result = SyncResult()
        plugin_ctx = context.plugin_context

        workspace_uuid = context.workspace_uuid or str(context.workspace_id)
        actor_uuid = context.actor_uuid or str(context.user_id)

        sync_url = await plugin_ctx.get_setting(
            context.workspace_id, context.user_id, "sync_url", ""
        )
        if not sync_url:
            result.messages.append("KOReader sync URL is not configured")
            return result

        client = KOReaderClient(sync_url)
        try:
            highlights = await client.fetch_highlights(limit=100)
        except Exception as exc:  # noqa: BLE001
            result.messages.append(f"Failed to fetch KOReader highlights: {exc}")
            return result

        source_class_uuid = await plugin_ctx.ensure_class(
            workspace_uuid,
            actor_uuid,
            "Source: KOReader",
            icon="book-open-variant",
        )
        source_classes = [source_class_uuid] if source_class_uuid else []

        books: dict[str, str] = {}
        for highlight in highlights:
            book_title = highlight.book_title or "Untitled book"
            if book_title not in books:
                book_uuid = await plugin_ctx.create_page(
                    workspace_uuid,
                    actor_uuid,
                    book_title,
                    class_uuids=source_classes,
                )
                books[book_title] = book_uuid

        result.created_node_ids.extend(books.values())
        result.messages.append(f"Synced {len(highlights)} highlights into {len(books)} books")
        return result
