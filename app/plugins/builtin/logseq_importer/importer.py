"""Logseq folder importer adapter."""

from __future__ import annotations

import zipfile

from app.core.uuid import uuidv7
from app.plugins.core.context import PluginContext
from app.plugins.core.ports import (
    ImportContext,
    ImporterAdapter,
    ImportResult,
)

from .parser import (
    LogseqMdBlock,
    LogseqMdPage,
    count_md_blocks,
    parse_logseq_zip,
)


def _paragraph_ast(text: str) -> list[dict[str, object]]:
    """Return a minimal Notees paragraph content AST for plain text."""
    return [
        {
            "type": "paragraph",
            "children": [{"text": text}],
        }
    ]


class LogseqFolderImporter(ImporterAdapter):
    """Import a ZIP of Logseq markdown files into Notees nodes."""

    id = "logseq.folder"
    label = "Logseq markdown folder"
    file_extensions = ["zip"]

    async def import_data(
        self,
        payload: bytes,
        _content_type: str | None,
        context: ImportContext,
    ) -> ImportResult:
        result = ImportResult()
        plugin_ctx = context.plugin_context
        workspace_uuid = context.workspace_uuid or str(context.workspace_id)
        actor_uuid = context.actor_uuid or str(context.user_id)

        try:
            parsed = parse_logseq_zip(payload)
        except (zipfile.BadZipFile, ValueError):
            result.messages.append("Uploaded file is not a valid ZIP archive")
            result.error_count += 1
            return result

        if not parsed.pages and not parsed.journals:
            result.messages.append("No Logseq pages or journals found in archive")
            return result

        source_class_uuid = await plugin_ctx.ensure_class(
            workspace_uuid,
            actor_uuid,
            "Source: Logseq",
            icon="file-document-outline",
        )
        source_classes = [source_class_uuid] if source_class_uuid else []

        total_blocks = 0
        created_pages: list[LogseqMdPage] = []

        for page in parsed.pages + parsed.journals:
            page_uuid = await plugin_ctx.create_page(
                workspace_uuid,
                actor_uuid,
                page.title,
                class_uuids=source_classes,
            )
            result.created_node_ids.append(page_uuid)
            created_pages.append(page)
            await self._create_blocks(
                plugin_ctx,
                workspace_uuid,
                actor_uuid,
                page_uuid,
                page.blocks,
                result,
            )
            total_blocks += count_md_blocks(page.blocks)

        for link_target in sorted(parsed.all_links):
            existing = await plugin_ctx.find_page_by_name(
                workspace_uuid, actor_uuid, link_target
            )
            if existing is None:
                stub_uuid = await plugin_ctx.create_page(
                    workspace_uuid,
                    actor_uuid,
                    link_target,
                    class_uuids=source_classes,
                )
                result.created_node_ids.append(stub_uuid)

        result.messages.append(
            f"Imported {len(parsed.pages)} pages, {len(parsed.journals)} journals, "
            f"{total_blocks} blocks, {len(parsed.all_links)} wiki-links, "
            f"{parsed.asset_count} assets"
        )
        return result

    async def _create_blocks(
        self,
        plugin_ctx: PluginContext,
        workspace_uuid: str,
        actor_uuid: str,
        parent_id: str,
        blocks: list[LogseqMdBlock],
        result: ImportResult,
    ) -> None:
        """Recursively create block nodes under ``parent_id``."""
        for index, block in enumerate(blocks):
            block_uuid = uuidv7()
            await plugin_ctx.create_node(
                workspace_uuid,
                actor_uuid,
                node_id=block_uuid,
                kind="block",
                parent_id=parent_id,
                index=index,
                initial_content=_paragraph_ast(block.content),
            )
            result.created_node_ids.append(block_uuid)
            if block.children:
                await self._create_blocks(
                    plugin_ctx,
                    workspace_uuid,
                    actor_uuid,
                    block_uuid,
                    block.children,
                    result,
                )
