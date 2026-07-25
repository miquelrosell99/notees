"""Domain service for importing external formats into Notees nodes.

This port uses the local-first :class:`app.core.workspace_store.WorkspaceStore`
to emit operations (``node.create``, ``node.updateContent``, ``class.assign``,
``property.set``) instead of mutating PostgreSQL rows through the legacy node
and property services.
"""

from __future__ import annotations

from typing import Any
from uuid import NAMESPACE_DNS, uuid5

from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.domain.stringify_ast import (
    ParseMode,
    StringifyMode,
    StringifyOptions,
    parse_ast,
    stringify_ast,
)
from app.features.import_.frontmatter_parser import normalize_metadata, parse_frontmatter
from app.logging_config import get_logger

logger = get_logger(__name__)


def _schema_uuid_for_name(name: str) -> str:
    """Return a deterministic schema UUID for a property name.

    The derived store does not yet materialise property schemas in Phase 7, so
    imports use a stable UUID derived from the property name as the
    ``schemaId`` for ``property.set`` operations.  This preserves idempotency
    for repeated imports of the same property without requiring a live
    PostgreSQL property repository.
    """
    return str(uuid5(NAMESPACE_DNS, f"notees:property:{name}"))


class ImportService:
    """Orchestrates import of Markdown documents via WorkspaceStore operations."""

    def __init__(self, store: WorkspaceStore) -> None:
        self._store = store

    # ------------------------------------------------------------------
    # Markdown import
    # ------------------------------------------------------------------

    async def import_markdown(
        self,
        content: str,
        parent_uuid: str | None = None,
        sequence: float = 0.0,
        uuid_conflict_mode: str = "block",
        user_id: int | None = None,
    ) -> tuple[str, str, bool]:
        """Import a single Markdown document and return (node_uuid, title, created)."""
        metadata, body = parse_frontmatter(content)
        metadata = normalize_metadata(metadata)

        title = self._extract_title(metadata, body)
        title_ast = parse_ast(title, ParseMode.PLAIN)

        node_uuid = metadata.get("uuid")
        if node_uuid is not None:
            node_uuid = str(node_uuid)
            existing = await self._node_exists(node_uuid)
            if existing:
                if uuid_conflict_mode == "block":
                    raise ValueError(f"Node with UUID {node_uuid} already exists")
                existing_title = await self._node_title(node_uuid)
                return node_uuid, existing_title, False
        else:
            node_uuid = uuidv7()

        parent_id = await self._resolve_parent(parent_uuid)
        class_ids = await self._resolve_classes(metadata.get("classes", []))
        await self._resolve_tags(metadata.get("tags", []), user_id=user_id)

        is_page = metadata.get("is_page", True)
        kind = "page" if is_page else "block"

        # 1. Create the node empty, then set its title via updateContent.
        await self._store.create_node(
            node_id=node_uuid,
            kind=kind,
            parent_id=parent_id,
            index=int(sequence),
        )
        await self._store.update_content(node_uuid, title_ast)

        # 2. Assign classes explicitly via class.assign operations.
        for class_id in class_ids:
            await self._store.assign_class(node_uuid, class_id)

        # 3. Persist icon / color as property.set operations.
        icon = metadata.get("icon")
        color = metadata.get("color")
        if icon:
            await self._set_property(node_uuid, "icon", icon)
        if color:
            await self._set_property(node_uuid, "color", color)

        # 4. Apply frontmatter properties.
        if "properties" in metadata and isinstance(metadata["properties"], dict):
            for name, value in metadata["properties"].items():
                await self._set_property(node_uuid, name, value)

        # 5. Append body as a child block.
        if body.strip():
            await self._append_body(node_uuid, body)

        return node_uuid, title, True

    def _extract_title(self, metadata: dict[str, Any], body: str) -> str:
        """Return the node title from frontmatter or the first Markdown heading."""
        if "title" in metadata:
            return str(metadata["title"])
        if "name" in metadata:
            return str(metadata["name"])
        first_line = body.strip().split("\n", 1)[0].strip()
        if first_line.startswith("# "):
            return first_line[2:].strip()
        return "Untitled"

    async def _node_exists(self, node_uuid: str) -> bool:
        rows = await self._store.query("SELECT 1 FROM node WHERE id = ?", (node_uuid,))
        return bool(rows)

    async def _resolve_parent(self, parent_uuid: str | None) -> str | None:
        if not parent_uuid:
            return None
        parent_uuid = str(parent_uuid)
        if not await self._node_exists(parent_uuid):
            raise ValueError(f"Parent node not found: {parent_uuid}")
        return parent_uuid

    async def _resolve_classes(self, entries: list[Any]) -> list[str]:
        if not entries:
            return []
        class_rows = await self._store.query(
            "SELECT id, name FROM class WHERE active = 1"
        )
        by_uuid: dict[str, str] = {row["id"]: row["id"] for row in class_rows}
        by_name: dict[str, str] = {}
        for row in class_rows:
            name = row["name"]
            if name:
                by_name[name.lower()] = row["id"]

        resolved: list[str] = []
        for entry in entries:
            class_id: str | None = None
            if isinstance(entry, str):
                class_id = by_uuid.get(entry) or by_name.get(entry.lower())
            elif isinstance(entry, dict):
                uuid = entry.get("uuid")
                name = entry.get("name")
                class_id = by_uuid.get(uuid) if uuid else None
                if class_id is None and name:
                    class_id = by_name.get(str(name).lower())
            if class_id is None:
                raise ValueError(f"Class not found: {entry}")
            resolved.append(class_id)
        return resolved

    async def _resolve_tags(self, entries: list[Any], user_id: int | None = None) -> list[str]:
        """Ensure tag pages exist, creating them when necessary.

        In the legacy model tags were tracked as ``tag_ids`` on the node. The
        Phase 7 derived schema has no tag association table, so the port keeps
        the existing tag *pages* alive by creating missing ones. Tag-to-page
        associations will be refined when the tag class/edge model stabilises.
        """
        tag_uuids: list[str] = []
        for entry in entries:
            name, uuid = self._unpack_name_uuid(entry)
            node_uuid = None
            if uuid and await self._node_exists(uuid):
                node_uuid = uuid
            if node_uuid is None and name:
                node_uuid = await self._find_page_by_name(name)
            if node_uuid is None and name:
                node_uuid = uuidv7()
                await self._store.create_node(
                    node_id=node_uuid,
                    kind="page",
                )
                await self._store.update_content(
                    node_uuid,
                    parse_ast(name, ParseMode.PLAIN),
                )
            if node_uuid is None:
                raise ValueError(f"Tag could not be resolved: {entry}")
            tag_uuids.append(node_uuid)
        return tag_uuids

    async def _set_property(
        self,
        node_uuid: str,
        name: str,
        value: Any,
    ) -> None:
        """Emit a ``property.set`` operation for a frontmatter property."""
        try:
            prepared = await self._prepare_property_value(value)
        except Exception as exc:
            logger.warning(f"Failed to prepare property '{name}' during import: {exc}")
            return
        await self._store.set_property(
            property_value_id=uuidv7(),
            node_id=node_uuid,
            schema_id=_schema_uuid_for_name(name),
            value=prepared,
            index=0,
        )

    async def _prepare_property_value(self, value: Any) -> Any:
        """Convert a frontmatter value into a value the property system expects."""
        if isinstance(value, list):
            return [await self._resolve_property_target(item) for item in value]
        return await self._resolve_property_target(value)

    async def _resolve_property_target(self, value: Any) -> Any:
        """Resolve string values that look like node UUIDs or names to UUIDs."""
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value
        if isinstance(value, dict):
            value = value.get("uuid") or value.get("name")
        if not isinstance(value, str):
            return value
        if await self._node_exists(value):
            return value
        page_uuid = await self._find_page_by_name(value)
        if page_uuid:
            return page_uuid
        return value

    async def _append_body(
        self,
        node_uuid: str,
        body: str,
    ) -> None:
        """Append the Markdown body as a child block under the imported page."""
        body_ast = parse_ast(body, ParseMode.MARKDOWN)
        if not body_ast:
            return
        block_uuid = uuidv7()
        await self._store.create_node(
            node_id=block_uuid,
            kind="block",
            parent_id=node_uuid,
        )
        await self._store.update_content(block_uuid, body_ast)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _unpack_name_uuid(self, entry: Any) -> tuple[str | None, str | None]:
        if isinstance(entry, str):
            return entry, None
        if isinstance(entry, dict):
            name = entry.get("name")
            uuid = entry.get("uuid")
            return (str(name) if name else None), (str(uuid) if uuid else None)
        return None, None

    def _node_content_to_text(self, content: str | None) -> str | None:
        if not content:
            return None
        try:
            ast = parse_ast(content, ParseMode.JSON)
            text: str = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
            return text
        except Exception:
            return None

    async def _node_title(self, node_uuid: str) -> str:
        """Return the plaintext title extracted from a node's content."""
        rows = await self._store.query(
            "SELECT content FROM node WHERE id = ?", (node_uuid,)
        )
        if not rows:
            return "Untitled"
        return self._node_content_to_text(rows[0]["content"]) or "Untitled"

    async def _find_page_by_name(self, name: str) -> str | None:
        """Return the UUID of a page whose plaintext content matches ``name``."""
        rows = await self._store.query(
            "SELECT id, content FROM node WHERE kind = 'page'"
        )
        target = name.strip().lower()
        for row in rows:
            plain = (self._node_content_to_text(row["content"]) or "").strip().lower()
            if plain == target:
                return str(row["id"])
        return None
