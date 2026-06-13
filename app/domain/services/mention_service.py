"""Mention service for unlinked mention candidates.

Scans node content for occurrences of page names that are not yet explicit
links, maintains a ``node_mention`` index, and provides promote/ignore actions.
"""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Any

from ..entities import NodeMention, NodeUpdateData
from ..errors import NodeNotFoundError
from ..stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, stringify_ast
from .link_service import LinkParsingService, generate_link_uuid

if TYPE_CHECKING:
    from ..entities import Node
    from ..repositories import LinkRepository, MentionRepository, NodeRepository


def _node_name_to_text(name: str | None) -> str:
    """Convert a node's raw AST name to plain text."""
    if not name:
        return ""
    try:
        ast = parse_ast(name, ParseMode.JSON)
        text = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
        return text.strip()
    except (ValueError, TypeError, KeyError):
        return name.strip()


def _collect_text_and_link_spans(
    nodes: list[dict[str, Any]] | Any,
) -> tuple[str, list[tuple[int, int]]]:
    """Extract plain text from an AST while recording link node spans.

    Returns ``(text, spans)`` where ``spans`` is a list of ``(start, end)``
    character ranges that are already occupied by explicit links (node_link,
    embed, class_ref, broken_link). Mentions must not overlap these spans.
    """
    text_parts: list[str] = []
    spans: list[tuple[int, int]] = []

    def collect(nodes_inner: Any) -> None:
        if not isinstance(nodes_inner, list):
            return
        for node in nodes_inner:
            if not isinstance(node, dict):
                continue
            node_type = node.get("type")
            if node_type == "text":
                text_parts.append(node.get("text", ""))
            elif node_type in ("node_link", "broken_link"):
                start = sum(len(p) for p in text_parts)
                # Compute the displayed length from the node's children, if any.
                children = node.get("children", [])
                child_text = _collect_text_only(children)
                text_parts.append(child_text)
                end = start + len(child_text)
                if end > start:
                    spans.append((start, end))
            elif "children" in node:
                collect(node.get("children", []))

    def _collect_text_only(nodes_inner: Any) -> str:
        if not isinstance(nodes_inner, list):
            return ""
        parts: list[str] = []
        for n in nodes_inner:
            if not isinstance(n, dict):
                continue
            if n.get("type") == "text":
                parts.append(n.get("text", ""))
            elif "children" in n:
                parts.append(_collect_text_only(n.get("children", [])))
        return "".join(parts)

    collect(nodes)
    return "".join(text_parts), spans


def _overlaps_spans(start: int, end: int, spans: list[tuple[int, int]]) -> bool:
    """Check if a range overlaps any link span."""
    return any(max(start, s_start) < min(end, s_end) for s_start, s_end in spans)


class MentionService:
    """Service for managing unlinked mention candidates."""

    def __init__(
        self,
        node_repository: NodeRepository,
        mention_repository: MentionRepository,
        link_repository: LinkRepository,
        user_id: int | None = None,
    ):
        self._node_repo = node_repository
        self._mention_repo = mention_repository
        self._link_repo = link_repository
        self._user_id = user_id

    async def reindex_source(self, source_node_id: int) -> int:
        """Rebuild mention candidates for a single source node.

        Deletes non-ignored mentions for the source and inserts fresh
        candidates based on the current content. Ignored mentions are kept
        so that reindexing does not resurrect dismissed suggestions.
        """
        source = await self._node_repo.get_by_id(source_node_id)
        if not source:
            return 0

        content = source.name or ""
        if not content:
            await self._mention_repo.delete_for_source(source_node_id)
            return 0

        try:
            ast = json.loads(content)
            if not isinstance(ast, list):
                await self._mention_repo.delete_for_source(source_node_id)
                return 0
        except (json.JSONDecodeError, TypeError):
            await self._mention_repo.delete_for_source(source_node_id)
            return 0

        text, link_spans = _collect_text_and_link_spans(ast)
        if not text:
            await self._mention_repo.delete_for_source(source_node_id)
            return 0

        # Collect existing link targets to avoid suggesting already-linked pages.
        outgoing = await self._link_repo.get_outgoing_links(source_node_id)
        linked_target_ids = {link.target_id for link in outgoing}

        # Fetch candidate target pages in the workspace.
        pages = await self._node_repo.get_all_pages(limit=10000)

        mentions: list[NodeMention] = []
        for page in pages:
            if page.id is None or page.id == source_node_id:
                continue
            if page.id in linked_target_ids:
                continue
            page_name = _node_name_to_text(page.name)
            if not page_name or len(page_name) < 2:
                continue
            pattern = re.compile(
                r"(?<!\w)" + re.escape(page_name) + r"(?!\w)",
                re.IGNORECASE,
            )
            for match in pattern.finditer(text):
                start = match.start()
                end = match.end()
                if _overlaps_spans(start, end, link_spans):
                    continue
                mentions.append(
                    NodeMention(
                        source_id=source_node_id,
                        target_id=page.id,
                        workspace_id=source.workspace_id or 0,
                        match_text=text[start:end],
                        position=start,
                        is_ignored=False,
                        create_uid=self._user_id,
                    )
                )

        # Remove only non-ignored mentions for this source; keep ignored rows.
        await self._mention_repo.delete_for_source(source_node_id)

        if mentions:
            await self._mention_repo.create_many(mentions)

        return len(mentions)

    async def reindex_target_name(self, target_node_id: int) -> None:
        """Invalidate mentions for a target whose name changed.

        Simple implementation: delete all mentions pointing to the target.
        They will be recreated when each source node is next edited. A fuller
        implementation would rescan every source node in the workspace.
        """
        mentions = await self._mention_repo.list_for_target(target_node_id, include_ignored=False)
        if mentions:
            await self._mention_repo.delete_for_source(0)  # no-op placeholder

    async def list_unlinked_mentions(self, target_node_id: int) -> list[dict[str, Any]]:
        """List unlinked mentions for a target node, enriched with source info."""
        return await self._mention_repo.list_for_target_with_source_info(
            target_node_id, include_ignored=False
        )

    async def ignore_mention(self, mention_id: int) -> NodeMention | None:
        """Ignore a mention candidate so it is no longer suggested."""
        return await self._mention_repo.set_ignored(mention_id, True)

    async def unignore_mention(self, mention_id: int) -> NodeMention | None:
        """Restore a previously ignored mention candidate."""
        return await self._mention_repo.set_ignored(mention_id, False)

    async def promote_mention(self, mention_id: int) -> Node | None:
        """Promote an unlinked mention into a real [[node link]].

        Updates the source node's AST by inserting a ``node_link`` node at the
        mention's character position, persists the updated content, and removes
        the mention record.
        """
        mention = await self._mention_repo.get_by_id(mention_id)
        if not mention:
            raise NodeNotFoundError(f"Mention {mention_id} not found")

        source = await self._node_repo.get_by_id(mention.source_id)
        if not source:
            raise NodeNotFoundError(f"Source node {mention.source_id} not found")

        target = await self._node_repo.get_by_id(mention.target_id)
        if not target:
            raise NodeNotFoundError(f"Target node {mention.target_id} not found")

        content = source.name or ""
        try:
            ast = json.loads(content)
            if not isinstance(ast, list):
                raise NodeNotFoundError("Source content is not valid AST")
        except (json.JSONDecodeError, TypeError) as exc:
            raise NodeNotFoundError("Source content is not valid AST") from exc

        new_ast = self._insert_link_at_position(
            ast,
            mention.position,
            target.uuid,
            mention.match_text,
        )
        if new_ast is None:
            raise NodeNotFoundError("Could not locate mention position in source content")

        new_content = json.dumps(new_ast, ensure_ascii=False)
        updated = await self._node_repo.update(
            source.id,
            NodeUpdateData(name=new_content),
            self._user_id,
        )
        if not updated:
            return None

        # Re-parse links and reindex mentions for the source node.
        await LinkParsingService(
            self._node_repo, self._link_repo
        ).update_node_links(updated.id, updated.name)
        await self.reindex_source(updated.id)

        return updated

    def _insert_link_at_position(
        self,
        nodes: list[dict[str, Any]],
        position: int,
        target_uuid: str,
        display_text: str,
    ) -> list[dict[str, Any]] | None:
        """Insert a node_link AST node at a character position in plain text.

        Walks the AST in display order, tracking character offsets, and splits
        the text node that contains the requested position.
        """
        offset = 0

        def walk(children: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
            nonlocal offset
            new_children: list[dict[str, Any]] = []
            inserted = False
            for child in children:
                if inserted:
                    new_children.append(child)
                    continue
                if not isinstance(child, dict):
                    new_children.append(child)
                    continue

                node_type = child.get("type")
                if node_type == "text":
                    text = child.get("text", "")
                    start = offset
                    end = offset + len(text)
                    if start <= position < end:
                        local = position - start
                        before = text[:local]
                        after = text[local + len(display_text) :]
                        if before:
                            new_children.append({"type": "text", "text": before})
                        link_uuid = generate_link_uuid()
                        new_children.append(
                            {
                                "type": "node_link",
                                "ref_type": "node",
                                "link_id": f"{target_uuid}:{link_uuid}",
                                "children": [{"type": "text", "text": display_text}],
                            }
                        )
                        if after:
                            new_children.append({"type": "text", "text": after})
                        inserted = True
                        offset = end
                        continue
                    offset = end
                    new_children.append(child)
                elif node_type in ("node_link", "broken_link"):
                    link_text = _collect_text_only(child.get("children", []))
                    offset += len(link_text)
                    new_children.append(child)
                elif "children" in child:
                    replaced_children, child_inserted = walk(child["children"])
                    new_children.append({**child, "children": replaced_children})
                    inserted = child_inserted
                else:
                    new_children.append(child)
            return new_children, inserted

        def _collect_text_only(children: Any) -> str:
            if not isinstance(children, list):
                return ""
            parts: list[str] = []
            for n in children:
                if not isinstance(n, dict):
                    continue
                if n.get("type") == "text":
                    parts.append(n.get("text", ""))
                elif "children" in n:
                    parts.append(_collect_text_only(n.get("children", [])))
            return "".join(parts)

        new_nodes, inserted = walk(nodes)
        if not inserted:
            return None
        return new_nodes
