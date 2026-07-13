"""Domain service for importing external formats into Notees nodes."""

from __future__ import annotations

from typing import Any

from app.domain.entities import Node, NodeCreateData, PropertyType
from app.domain.stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, serialize_ast, stringify_ast
from app.features.import_.frontmatter_parser import normalize_metadata, parse_frontmatter
from app.features.nodes.node_service import NodeService
from app.features.nodes.port import NodeRepository
from app.features.properties.port import PropertyRepository
from app.features.properties.service import PropertyService
from app.logging_config import get_logger

logger = get_logger(__name__)


class ImportService:
    """Orchestrates import of Markdown documents."""

    def __init__(
        self,
        node_service: NodeService,
        property_service: PropertyService,
        node_repo: NodeRepository,
        property_repo: PropertyRepository,
    ) -> None:
        self._node_service = node_service
        self._property_service = property_service
        self._node_repo = node_repo
        self._property_repo = property_repo

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
    ) -> tuple[Node, bool]:
        """Import a single Markdown document and return (node, created)."""
        metadata, body = parse_frontmatter(content)
        metadata = normalize_metadata(metadata)

        title = self._extract_title(metadata, body)
        name_ast = parse_ast(title, ParseMode.PLAIN)

        node_uuid = metadata.get("uuid")
        if node_uuid is not None:
            node_uuid = str(node_uuid)
            existing = await self._node_repo.get_by_uuid(node_uuid)
            if existing is not None:
                if uuid_conflict_mode == "block":
                    raise ValueError(f"Node with UUID {node_uuid} already exists")
                return existing, False

        parent_id = await self._resolve_parent(parent_uuid)
        classes = await self._resolve_classes(metadata.get("classes", []))
        tags = await self._resolve_tags(metadata.get("tags", []), user_id=user_id)

        page_class_id = self._node_service.page_class_id
        is_page = metadata.get("is_page", True)
        if is_page and page_class_id is not None and page_class_id not in classes:
            classes.insert(0, page_class_id)

        data = NodeCreateData(
            uuid=node_uuid,
            name=serialize_ast(name_ast),
            icon=metadata.get("icon"),
            color=metadata.get("color"),
            parent_id=parent_id,
            sequence=sequence,
            classes=classes,
            tags=tags,
        )

        node = await self._node_service.create_node(data, user_id)

        if "properties" in metadata and isinstance(metadata["properties"], dict):
            await self._apply_properties(node.id, metadata["properties"])

        if body.strip():
            await self._append_body(node, body, user_id=user_id)

        return node, True

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

    async def _resolve_parent(self, parent_uuid: str | None) -> int | None:
        if not parent_uuid:
            return None
        parent = await self._node_repo.get_by_uuid(str(parent_uuid))
        if parent is None:
            raise ValueError(f"Parent node not found: {parent_uuid}")
        return parent.id

    async def _resolve_classes(self, entries: list[Any]) -> list[int]:
        if not entries:
            return []
        class_nodes = await self._node_repo.list_classes()
        by_uuid = {n.uuid: n for n in class_nodes}
        by_name: dict[str, Node] = {}
        for n in class_nodes:
            plain = self._node_name_to_text(n.name)
            if plain:
                by_name[plain.lower()] = n

        resolved: list[int] = []
        for entry in entries:
            node = None
            if isinstance(entry, str):
                node = by_uuid.get(entry) or by_name.get(entry.lower())
            elif isinstance(entry, dict):
                uuid = entry.get("uuid")
                name = entry.get("name")
                node = by_uuid.get(uuid) if uuid else None
                if node is None and name:
                    node = by_name.get(str(name).lower())
            if node is None:
                raise ValueError(f"Class not found: {entry}")
            resolved.append(node.id)
        return resolved

    async def _resolve_tags(self, entries: list[Any], user_id: int | None = None) -> list[int]:
        if not entries:
            return []
        tag_ids: list[int] = []
        for entry in entries:
            name, uuid = self._unpack_name_uuid(entry)
            node = None
            if uuid:
                node = await self._node_repo.get_by_uuid(uuid)
            if node is None and name:
                pages = await self._node_repo.find_page_by_name(name, parent_id=None)
                for row in pages:
                    if row.get("is_page"):
                        node = await self._node_repo.get_by_id(row["id"])
                        break
            if node is None and name:
                created = await self._node_service.create_page(
                    name=name,
                    user_id=user_id,
                )
                node = created
            if node is None:
                raise ValueError(f"Tag could not be resolved: {entry}")
            tag_ids.append(node.id)
        return tag_ids

    async def _apply_properties(self, node_id: int | None, properties: dict[str, Any]) -> None:
        if node_id is None:
            return
        for name, value in properties.items():
            prop = await self._property_repo.get_by_name(str(name))
            if prop is None:
                logger.warning(f"Property '{name}' not found during import; skipping")
                continue
            try:
                prepared = await self._prepare_property_value(prop, value)
                await self._property_service.set_property_value(
                    node_id=node_id,
                    property_id=prop.id,
                    value=prepared,
                    run_automations=False,
                    log_activity=False,
                )
            except Exception as exc:
                logger.warning(f"Failed to set property '{name}' during import: {exc}")

    async def _prepare_property_value(self, prop: Any, value: Any) -> Any:
        """Convert a frontmatter value into a value the property system expects."""
        prop_type = prop.type
        if prop_type in (PropertyType.INTEGER, PropertyType.FLOAT, PropertyType.BOOLEAN, PropertyType.TEXT):
            return value

        if prop_type == PropertyType.NODE:
            if isinstance(value, list):
                return [await self._resolve_node_target(item) for item in value]
            return await self._resolve_node_target(value)

        if prop_type == PropertyType.SELECTION:
            lines = await self._property_repo.get_selection_lines(prop.id)
            by_name = {line.name: line.id for line in lines if line.name}
            by_uuid = {line.uuid: line.id for line in lines}
            if isinstance(value, list):
                return [self._resolve_selection_target(item, by_name, by_uuid) for item in value]
            return self._resolve_selection_target(value, by_name, by_uuid)

        if prop_type == PropertyType.DATE_RANGE:
            return value

        return value

    async def _resolve_node_target(self, value: Any) -> int:
        if isinstance(value, int):
            return value
        if isinstance(value, dict):
            value = value.get("uuid") or value.get("name")
        if not isinstance(value, str):
            raise ValueError(f"Node property target must be a UUID or name, got {type(value)}")
        target = await self._node_repo.get_by_uuid(value)
        if target is None:
            pages = await self._node_repo.find_page_by_name(value, parent_id=None)
            if pages:
                target = await self._node_repo.get_by_id(pages[0]["id"])
        if target is None or target.id is None:
            raise ValueError(f"Node property target not found: {value}")
        return target.id

    def _resolve_selection_target(
        self,
        value: Any,
        by_name: dict[str, int],
        by_uuid: dict[str, int],
    ) -> int:
        if isinstance(value, int):
            return value
        if isinstance(value, dict):
            value = value.get("uuid") or value.get("name")
        if not isinstance(value, str):
            raise ValueError(f"Selection property target must be a line name or UUID, got {type(value)}")
        if value in by_uuid:
            return by_uuid[value]
        if value in by_name:
            return by_name[value]
        raise ValueError(f"Selection line not found: {value}")

    async def _append_body(
        self,
        node: Node,
        body: str,
        user_id: int | None = None,
    ) -> None:
        """Append the Markdown body as child blocks under the imported page."""
        if node.id is None:
            return
        body_ast = parse_ast(body, ParseMode.MARKDOWN)
        # For now, create a single child block containing the parsed AST.
        # A future enhancement could split top-level blocks into separate nodes.
        if not body_ast:
            return
        await self._node_service.create_block(
            name=serialize_ast(body_ast),
            parent_id=node.id,
            user_id=user_id,
        )

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

    def _node_name_to_text(self, name: str) -> str:
        try:
            ast = parse_ast(name)
            return stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
        except Exception:
            return name
