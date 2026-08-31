"""ExportServices implementation over the operation-log core.

Gives the engine and providers controlled access to the derived state
(query engine, class resolver, asset metadata/streaming) without exposing
canonical storage paths — providers receive metadata and streams only.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, BinaryIO

from app.core.query_ast.compiler import generate_sql_from_ast
from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.domain.entities.query_ast import QueryAST
from app.features.assets.service import AssetFileService
from app.logging_config import get_logger
from app.plugins.core.export import ExportAttachment, ExportNodeContext

logger = get_logger(__name__)

ATTACHMENTS_SCHEMA_UUID = SYSTEM_PROPERTY_UUIDS["attachments"]
AUTHORS_SCHEMA_UUID = SYSTEM_PROPERTY_UUIDS["authors"]
ROLE_SCHEMA_UUID = SYSTEM_PROPERTY_UUIDS["role"]
ASSET_CLASS_UUID = SYSTEM_CLASS_UUIDS["asset"]

# Role option UUID → option name, from the system `role` selection schema.
_ROLE_OPTION_NAMES = {
    "00000000-0000-0000-0004-000000000001": "representation",
    "00000000-0000-0000-0004-000000000002": "cover",
    "00000000-0000-0000-0004-000000000003": "supplement",
    "00000000-0000-0000-0004-000000000004": "attachment",
    "00000000-0000-0000-0004-000000000005": "generated",
    "00000000-0000-0000-0004-000000000006": "thumbnail",
    "00000000-0000-0000-0004-000000000007": "other",
}


class QueryResolutionError(Exception):
    """Raised when a profile query cannot be resolved."""


def _content_to_title(raw_content: str | None) -> str:
    """Extract plain-text title from a node's JSON content."""
    if not raw_content:
        return ""
    try:
        content = json.loads(raw_content)
    except (ValueError, TypeError):
        return ""

    def _walk(node: Any) -> str:
        if isinstance(node, dict):
            if "text" in node:
                text = node["text"]
                return text if isinstance(text, str) else ""
            return "".join(_walk(child) for child in node.get("children", []))
        if isinstance(node, list):
            return "".join(_walk(child) for child in node)
        return ""

    return _walk(content).strip()


class WorkspaceExportServices:
    """ExportServices backed by a WorkspaceStore and the CAS asset store."""

    def __init__(
        self,
        store: WorkspaceStore,
        asset_files: AssetFileService | None = None,
    ) -> None:
        self._store = store
        self._asset_files = asset_files or AssetFileService(store.workspace_id)

    # ── Query engine ────────────────────────────────────────────────────

    async def select_node_ids(self, query: dict[str, Any]) -> list[str]:
        """Resolve a profile query (inline AST or saved-query ref) to node ids."""
        await self._store.sync()
        ast_dict = await self._resolve_ast_dict(query)
        ast = QueryAST.from_dict(ast_dict)
        sql, params = generate_sql_from_ast(ast, self._store.workspace_id)
        rows = await self._store.query(sql, tuple(params))
        return sorted({row["id"] for row in rows})

    async def _resolve_ast_dict(self, query: dict[str, Any]) -> dict[str, Any]:
        if isinstance(query.get("ast"), dict):
            ast: dict[str, Any] = query["ast"]
            return ast
        saved_query_id = query.get("saved_query_id")
        if saved_query_id:
            rows = await self._store.query(
                "SELECT query_ast FROM node_view WHERE id = ? AND active = 1",
                (str(saved_query_id),),
            )
            if not rows or not rows[0]["query_ast"]:
                raise QueryResolutionError(
                    f"Saved query {saved_query_id!r} not found or has no AST"
                )
            try:
                parsed = json.loads(rows[0]["query_ast"])
            except (ValueError, TypeError) as exc:
                raise QueryResolutionError(
                    f"Saved query {saved_query_id!r} has an unreadable AST"
                ) from exc
            if not isinstance(parsed, dict):
                raise QueryResolutionError(
                    f"Saved query {saved_query_id!r} AST is not an object"
                )
            return parsed
        raise QueryResolutionError(
            "Profile query must contain 'ast' or 'saved_query_id'"
        )

    # ── Node contexts ───────────────────────────────────────────────────

    async def build_node_contexts(
        self, node_uuids: list[str]
    ) -> list[ExportNodeContext]:
        contexts: list[ExportNodeContext] = []
        for node_uuid in sorted(node_uuids):
            context = await self._build_node_context(node_uuid)
            if context is not None:
                contexts.append(context)
        return contexts

    async def _build_node_context(self, node_uuid: str) -> ExportNodeContext | None:
        rows = await self._store.query(
            "SELECT id, content FROM node WHERE id = ? AND active = 1", (node_uuid,)
        )
        if not rows:
            return None
        properties = await self._property_map(node_uuid)
        # Resolve author node references to display names for {author}.
        author_uuids = properties.get("authors")
        if isinstance(author_uuids, list) and author_uuids:
            names = await self._node_titles([str(u) for u in author_uuids])
            properties["author"] = names[0] if names else None
            properties["authors"] = names
        return ExportNodeContext(
            uuid=node_uuid,
            title=_content_to_title(rows[0]["content"]),
            class_names=await self.resolve_class_names(node_uuid),
            properties=properties,
            attachments=await self._attachments_for(node_uuid),
        )

    async def _node_titles(self, node_uuids: list[str]) -> list[str]:
        titles: list[str] = []
        for uuid in node_uuids:
            rows = await self._store.query(
                "SELECT content FROM node WHERE id = ? AND active = 1", (uuid,)
            )
            if rows:
                title = _content_to_title(rows[0]["content"])
                if title:
                    titles.append(title)
        return titles

    async def _property_map(self, node_uuid: str) -> dict[str, Any]:
        """Return property values keyed by schema name (multi → ordered list)."""
        rows = await self._store.query(
            """
            SELECT ps.name AS name, ps.multi AS multi, pv.idx AS idx, pv.value AS value
            FROM property_value pv
            JOIN property_schema ps ON ps.id = pv.property_schema_id
            WHERE pv.node_id = ? AND ps.active = 1
            ORDER BY ps.name, pv.idx
            """,
            (node_uuid,),
        )
        singles: dict[str, Any] = {}
        multis: dict[str, list[Any]] = {}
        for row in rows:
            try:
                value = json.loads(row["value"])
            except (ValueError, TypeError):
                continue
            if row["multi"]:
                multis.setdefault(row["name"], []).append(value)
            else:
                singles[row["name"]] = value
        return {**singles, **multis}

    async def _attachments_for(self, node_uuid: str) -> list[ExportAttachment]:
        rows = await self._store.query(
            "SELECT value FROM property_value "
            "WHERE node_id = ? AND property_schema_id = ? ORDER BY idx",
            (node_uuid, ATTACHMENTS_SCHEMA_UUID),
        )
        attachments: list[ExportAttachment] = []
        for row in rows:
            try:
                asset_uuid = json.loads(row["value"])
            except (ValueError, TypeError):
                continue
            metadata = await self.get_asset_metadata(str(asset_uuid))
            if metadata is not None:
                attachments.append(metadata)
        return attachments

    # ── Class resolver ──────────────────────────────────────────────────

    async def resolve_class_names(self, node_uuid: str) -> list[str]:
        """Class names of a node, most specific first, then alphabetical."""
        rows = await self._store.query(
            "SELECT class_ids FROM node WHERE id = ?", (node_uuid,)
        )
        if not rows:
            return []
        try:
            class_ids = json.loads(rows[0]["class_ids"]) or []
        except (ValueError, TypeError):
            class_ids = []
        if not class_ids:
            return []

        # Drop classes that are ancestors of another assigned class so the
        # most specific class leads (e.g. "book" before "source").
        ancestor_rows = await self._store.query(
            "SELECT class_id, ancestor_id FROM class_hierarchy WHERE class_id IN "
            + "(" + ",".join("?" for _ in class_ids) + ")",
            tuple(class_ids),
        )
        ancestors_of_assigned: dict[str, set[str]] = {}
        for row in ancestor_rows:
            ancestors_of_assigned.setdefault(row["class_id"], set()).add(
                row["ancestor_id"]
            )
        assigned = set(class_ids)
        specific = [
            class_id
            for class_id in class_ids
            if not (ancestors_of_assigned.get(class_id, set()) & assigned)
        ]

        name_rows = await self._store.query(
            "SELECT id, name FROM class WHERE id IN "
            + "(" + ",".join("?" for _ in class_ids) + ") AND active = 1",
            tuple(class_ids),
        )
        names_by_id = {row["id"]: row["name"] for row in name_rows}
        ordered = [names_by_id[c] for c in specific if c in names_by_id]
        ordered += sorted(
            names_by_id[c]
            for c in class_ids
            if c in names_by_id and c not in set(specific)
        )
        return ordered

    # ── Asset metadata / streaming ──────────────────────────────────────

    async def get_asset_metadata(self, asset_uuid: str) -> ExportAttachment | None:
        rows = await self._store.query(
            """
            SELECT n.id AS node_id, a.asset_hash, a.mime_type, a.size, a.original_name
            FROM node n
            JOIN node_asset a ON a.node_id = n.id
            WHERE n.id = ? AND n.active = 1
            """,
            (asset_uuid,),
        )
        if not rows:
            return None
        row = rows[0]
        return ExportAttachment(
            asset_uuid=asset_uuid,
            asset_hash=row["asset_hash"],
            mime_type=row["mime_type"],
            size=row["size"],
            original_name=row["original_name"],
            role=await self._asset_role(asset_uuid),
        )

    async def _asset_role(self, asset_uuid: str) -> str | None:
        rows = await self._store.query(
            "SELECT value FROM property_value "
            "WHERE node_id = ? AND property_schema_id = ? ORDER BY idx LIMIT 1",
            (asset_uuid, ROLE_SCHEMA_UUID),
        )
        if not rows:
            return None
        try:
            raw = json.loads(rows[0]["value"])
        except (ValueError, TypeError):
            return None
        if not isinstance(raw, str) or not raw:
            return None
        # Selection values may be stored as option UUIDs or option names.
        return _ROLE_OPTION_NAMES.get(raw, raw)

    async def open_asset_stream(self, asset_uuid: str) -> BinaryIO | None:
        rows = await self._store.query(
            "SELECT asset_hash FROM node_asset WHERE node_id = ?", (asset_uuid,)
        )
        if not rows:
            return None
        path: Path | None = self._asset_files.find_source_file(rows[0]["asset_hash"])
        if path is None:
            return None
        try:
            return path.open("rb")
        except OSError:
            return None
