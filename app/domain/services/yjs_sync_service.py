"""Yjs Sync Service: bidirectional conversion between Notees AST and Yjs documents.

Provides:
- AST → Yjs document conversion (for dual-write and backfill)
- Yjs document → AST conversion (for AST reconciler)
- Page-level document construction from block rows
"""

from __future__ import annotations

import json
from typing import Any

import y_py

from ...logging_config import get_logger

logger = get_logger(__name__)

# Formatting marks that map to Y.Text attributes
_MARK_ATTRS: dict[str, str] = {
    "strong": "strong",
    "em": "em",
    "strikethrough": "strikethrough",
    "highlight": "highlight",
    "underline": "underline",
}


def _flatten_inline_nodes(nodes: list[dict[str, Any]], base_attrs: dict[str, Any] | None = None) -> list[tuple[str, dict[str, Any]]]:
    """Flatten nested AST inline nodes into (text, attributes) pairs for Y.Text.

    Example:
        [{"type":"text","text":"a "},{"type":"strong","children":[{"type":"text","text":"bold"}]}]
      → [("a ", {}), ("bold", {"strong": True})]
    """
    result: list[tuple[str, dict[str, Any]]] = []
    attrs = base_attrs or {}

    for node in nodes:
        node_type = node.get("type", "text")

        if node_type == "text":
            result.append((node.get("text", ""), attrs.copy()))

        elif node_type == "hard_break":
            result.append(("\n", attrs.copy()))

        elif node_type == "code":
            code_attrs = {**attrs, "code": True}
            result.append((node.get("text", ""), code_attrs))

        elif node_type in _MARK_ATTRS:
            child_attrs = {**attrs, _MARK_ATTRS[node_type]: True}
            children = node.get("children", [])
            result.extend(_flatten_inline_nodes(children, child_attrs))

        elif node_type == "node_link":
            link_attrs = {**attrs, "node_link": node.get("link_id", ""), "ref_type": node.get("ref_type", "node")}
            label = node.get("label")
            if label:
                result.append((label, link_attrs))
            else:
                # Placeholder for links without label — will be resolved by frontend
                result.append(("\u200B", link_attrs))

        elif node_type == "broken_link":
            link_attrs = {**attrs, "broken_link": node.get("link_id", "")}
            label = node.get("label", "")
            result.append((label or "\u200B", link_attrs))

        elif node_type == "external_link":
            link_attrs = {**attrs, "external_link": node.get("url", "")}
            children = node.get("children", [])
            if children:
                result.extend(_flatten_inline_nodes(children, link_attrs))
            else:
                result.append((node.get("url", ""), link_attrs))

        else:
            # Unknown inline node — treat as plain text if it has text
            if "text" in node:
                result.append((node["text"], attrs.copy()))
            # If it has children, recurse
            elif "children" in node:
                result.extend(_flatten_inline_nodes(node["children"], attrs))

    return result


def _ast_to_ytext(nodes: list[dict[str, Any]]) -> y_py.YText:
    """Convert AST inline nodes to a Y.Text with formatting attributes."""
    ytext = y_py.YText()
    flattened = _flatten_inline_nodes(nodes)
    offset = 0
    for text, attrs in flattened:
        if text:
            ytext.insert(offset, text, attrs)
            offset += len(text)
    return ytext


def _ytext_to_ast_nodes(ytext: y_py.YText) -> list[dict[str, Any]]:
    """Convert a Y.Text back to AST inline nodes.

    This is a simplified reconstruction. Full fidelity would require segmenting
    by attribute changes and rebuilding nested mark nodes.
    """
    text = str(ytext)
    if not text:
        return [{"type": "text", "text": ""}]

    # For now, return a single plain text node.
    # A full implementation would parse the delta format and reconstruct marks.
    # TODO: Implement full delta-to-AST reconstruction in Phase 4
    return [{"type": "text", "text": text}]


def build_yjs_doc_from_page_blocks(page_name: str, blocks: list[dict[str, Any]]) -> y_py.YDoc:
    """Build a Yjs document from a page title and list of block rows.

    Args:
        page_name: JSON AST string for the page title
        blocks: List of block dicts with keys: uuid, name (AST JSON), parent_id, sequence, etc.

    Returns:
        A Yjs YDoc representing the page
    """
    doc = y_py.YDoc()

    # Meta map
    meta = doc.get_map("meta")
    try:
        title_ast = json.loads(page_name) if page_name else []
        if not isinstance(title_ast, list):
            title_ast = []
    except json.JSONDecodeError:
        title_ast = [{"type": "paragraph", "children": [{"type": "text", "text": page_name or ""}]}]

    title_text = _ast_to_ytext(title_ast)
    meta.set("title", title_text)

    # Blocks array
    y_blocks = doc.get_array("blocks")

    # Sort blocks by sequence
    sorted_blocks = sorted(blocks, key=lambda b: b.get("sequence", 0))

    for block in sorted_blocks:
        block_map = y_py.YMap()
        block_uuid = str(block.get("uuid", ""))
        block_map.set("id", block_uuid)
        block_map.set("type", "paragraph")  # Default; we could infer from AST

        # Parse block content AST
        name = block.get("name", "")
        try:
            block_ast = json.loads(name) if name else []
            if not isinstance(block_ast, list):
                block_ast = []
        except json.JSONDecodeError:
            block_ast = [{"type": "paragraph", "children": [{"type": "text", "text": name or ""}]}]

        # Flatten to Y.Text
        block_content = _ast_to_ytext(block_ast)
        block_map.set("content", block_content)
        block_map.set("collapsed", bool(block.get("collapsed", False)))

        y_blocks.append(block_map)

    return doc


async def backfill_page_yjs_state(page_uuid: str) -> None:
    """Compute and save the Yjs document for an existing page from its AST blocks.

    This is used during Phase 2 to populate yjs_state_vector for existing pages.
    """
    from ...db.connection import get_connection

    async with get_connection() as conn:
        # Fetch page node
        page_row = await conn.fetchrow(
            "SELECT id, name FROM node WHERE uuid::text = $1 AND is_page = TRUE AND active = TRUE",
            page_uuid,
        )
        if not page_row:
            logger.warning(f"Page {page_uuid} not found for Yjs backfill")
            return

        page_id = page_row["id"]
        page_name = page_row["name"]

        # Fetch all non-page children (blocks)
        block_rows = await conn.fetch(
            """
            SELECT uuid, name, sequence, collapsed
            FROM node
            WHERE parent_id = $1 AND is_page = FALSE AND active = TRUE AND (is_deleted = FALSE OR is_deleted IS NULL)
            ORDER BY sequence ASC
            """,
            page_id,
        )

        blocks = [dict(row) for row in block_rows]
        doc = build_yjs_doc_from_page_blocks(page_name, blocks)

        snapshot = y_py.encode_state_as_update(doc)
        state_vector = y_py.encode_state_vector(doc)

        await conn.execute(
            """
            INSERT INTO yjs_state_vector (page_uuid, snapshot_bytes, state_vector)
            VALUES ($1, $2, $3)
            ON CONFLICT (page_uuid) DO UPDATE SET
              snapshot_bytes = EXCLUDED.snapshot_bytes,
              state_vector = EXCLUDED.state_vector,
              updated_at = NOW()
            """,
            page_uuid,
            snapshot,
            state_vector,
        )

        logger.info(f"Backfilled Yjs state for page {page_uuid} with {len(blocks)} blocks")


class YjsSyncService:
    """Service that maintains Yjs document consistency with REST mutations."""

    def __init__(self) -> None:
        pass

    async def on_node_content_changed(self, node_id: int) -> None:
        """Trigger a Yjs document rebuild when a block's content changes.

        This is called after a successful REST update to a block's `name` field.
        We rebuild the entire page's Yjs document to guarantee consistency.
        """
        from ...db.connection import get_connection

        async with get_connection() as conn:
            # Find the page this block belongs to
            row = await conn.fetchrow(
                """
                SELECT page_id FROM node WHERE id = $1
                """,
                node_id,
            )
            if not row or not row["page_id"]:
                return

            page_id = row["page_id"]

            # Get page UUID
            page_row = await conn.fetchrow(
                "SELECT uuid::text as uuid FROM node WHERE id = $1",
                page_id,
            )
            if not page_row:
                return

            page_uuid = page_row["uuid"]

            # Rebuild Yjs state
            await backfill_page_yjs_state(page_uuid)
            logger.debug(f"Rebuilt Yjs state for page {page_uuid} after block {node_id} content change")

    async def on_node_structure_changed(self, node_id: int) -> None:
        """Trigger a Yjs document rebuild when a block's structure changes.

        Called after parent_id or sequence updates.
        """
        await self.on_node_content_changed(node_id)

    async def on_node_created(self, node_id: int) -> None:
        """Trigger a Yjs document rebuild when a new block is created."""
        await self.on_node_content_changed(node_id)

    async def on_node_deleted(self, page_uuid: str) -> None:
        """Trigger a Yjs document rebuild when a block is deleted."""
        if page_uuid:
            await backfill_page_yjs_state(page_uuid)
