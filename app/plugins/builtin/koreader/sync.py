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

        source_class_id = await plugin_ctx.ensure_class(
            context.workspace_id,
            context.user_id,
            "Source: KOReader",
            icon="book-open-variant",
        )

        books: dict[str, int] = {}
        for highlight in highlights:
            book_title = highlight.book_title or "Untitled book"
            if book_title not in books:
                book_node = await plugin_ctx.create_page(
                    context.workspace_id,
                    context.user_id,
                    book_title,
                    additional_classes=[source_class_id],
                )
                books[book_title] = book_node.id

            # TODO: create child blocks for each highlight once create_block helper exists.

        result.messages.append(f"Synced {len(highlights)} highlights into {len(books)} books")
        return result
