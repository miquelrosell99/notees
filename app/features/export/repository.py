"""WorkspaceStore-backed implementation of ExportRepository.

Contains the SQL-heavy data fetching for node export. Rendering/formatting
logic lives in app.infrastructure.export and is orchestrated by ExportService.
"""

from __future__ import annotations

import json
import re
from typing import Any
from uuid import UUID

from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, parse_date_uuid
from app.domain.stringify_ast import (
    StringifyMode,
    StringifyOptions,
    parse_ast,
    stringify_ast,
)
from app.features.export.port import ExportRepository

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


class WorkspaceStoreExportRepository(ExportRepository):
    """Export repository that reads from the operation-log derived SQLite store."""

    def __init__(self, actor_id: str):
        self._actor_id = actor_id

    def _store(self, workspace_uuid: str) -> WorkspaceStore:
        """Create a fresh WorkspaceStore for the given workspace."""
        return WorkspaceStore(
            workspace_id=workspace_uuid,
            actor_id=self._actor_id,
        )

    @staticmethod
    def _placeholders(n: int) -> str:
        return ", ".join("?" for _ in range(n))

    @staticmethod
    def _is_uuid(value: Any) -> bool:
        if isinstance(value, UUID):
            return True
        if not isinstance(value, str):
            return False
        return bool(_UUID_RE.match(value))

    @staticmethod
    def _extract_plain_text(content: str | None) -> str:
        if not content:
            return "untitled"
        try:
            ast = parse_ast(content)
            opts = StringifyOptions(mode=StringifyMode.TEXT_ONLY)
            return stringify_ast(ast, opts) or "untitled"
        except (ValueError, TypeError):
            return content.strip() or "untitled"

    @staticmethod
    def _parse_class_ids(value: str | None) -> list[str]:
        if not value:
            return []
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return [str(item) for item in parsed]
        except (json.JSONDecodeError, TypeError):
            pass
        return []

    @staticmethod
    def _legacy_property_type(schema_type: str, raw_value: Any) -> str:
        """Map ideal property schema types back to legacy export type names."""
        if schema_type == "number":
            return "integer" if isinstance(raw_value, int) else "float"
        if schema_type == "checkbox":
            return "boolean"
        if schema_type in ("select", "multi_select"):
            return "selection"
        if schema_type == "node":
            return "node"
        if schema_type == "date":
            return "date"
        return "text"

    @staticmethod
    def _selection_name(
        schema_options: list[dict[str, Any]], option_id: str
    ) -> str | None:
        for option in schema_options:
            if option.get("id") == option_id:
                return option.get("name")
        return None

    async def get_export_node_tree(
        self,
        workspace_uuid: str,
        node_uuid: str,
        include_children: bool,
        include_child_pages: bool = False,
    ) -> list[dict[str, Any]]:
        store = self._store(workspace_uuid)
        try:
            await store.sync()
            if include_children:
                page_filter = "" if include_child_pages else "AND n.kind != 'page'"
                rows = await store.query(
                    f"""
                    WITH RECURSIVE tree AS (
                        SELECT
                            n.id,
                            n.content AS name,
                            n.parent_id,
                            n.kind,
                            n.class_ids,
                            0 AS depth,
                            n.id AS root_id,
                            CAST(COALESCE(nco.position, '0') AS INTEGER) AS child_position
                        FROM node n
                        LEFT JOIN node_child_order nco ON nco.child_id = n.id
                        WHERE n.workspace_id = ? AND n.id = ?
                        UNION ALL
                        SELECT
                            n.id,
                            n.content AS name,
                            n.parent_id,
                            n.kind,
                            n.class_ids,
                            t.depth + 1,
                            t.root_id,
                            CAST(COALESCE(nco.position, '0') AS INTEGER) AS child_position
                        FROM node n
                        JOIN tree t ON n.parent_id = t.id
                        LEFT JOIN node_child_order nco ON nco.child_id = n.id
                        WHERE n.workspace_id = ?
                          {page_filter}
                    )
                    SELECT id, name, parent_id, kind, class_ids, depth
                    FROM tree
                    ORDER BY root_id, depth, child_position, id
                    """,
                    (workspace_uuid, node_uuid, workspace_uuid),
                )
            else:
                rows = await store.query(
                    """
                    SELECT id, content AS name, parent_id, kind, class_ids
                    FROM node
                    WHERE workspace_id = ? AND id = ?
                    """,
                    (workspace_uuid, node_uuid),
                )
            return [
                {
                    "id": row["id"],
                    "uuid": row["id"],
                    "name": row["name"],
                    "is_page": row["kind"] == "page",
                    "color": None,
                    "class_ids": self._parse_class_ids(row["class_ids"]),
                    "depth": row["depth"] if include_children else 0,
                }
                for row in rows
            ]
        finally:
            await store.close()

    async def filter_text_property_node_ids(
        self, workspace_uuid: str, node_uuids: list[str]
    ) -> set[str]:
        if not node_uuids:
            return set()
        # Text properties whose value is a node UUID reference the text node as
        # their content. In the derived schema that value is stored as
        # `{"value": "<target-uuid>"}` in property_value.value.
        placeholders = self._placeholders(len(node_uuids))
        store = self._store(workspace_uuid)
        try:
            await store.sync()
            rows = await store.query(
                f"""
                SELECT DISTINCT json_extract(pv.value, '$.value') AS target_id
                FROM property_value pv
                JOIN property_schema ps ON ps.id = pv.property_schema_id
                WHERE ps.type = 'text'
                  AND json_extract(pv.value, '$.value') IS NOT NULL
                  AND json_extract(pv.value, '$.value') IN ({placeholders})
                """,
                tuple(node_uuids),
            )
            return {str(row["target_id"]) for row in rows if row["target_id"]}
        finally:
            await store.close()

    async def get_system_class_map(
        self, workspace_uuid: str, uuids: list[str]
    ) -> dict[str, str]:
        if not uuids:
            return {}
        placeholders = self._placeholders(len(uuids))
        store = self._store(workspace_uuid)
        try:
            await store.sync()
            rows = await store.query(
                f"""
                SELECT id, content
                FROM node
                WHERE workspace_id = ?
                  AND kind = 'class'
                  AND id IN ({placeholders})
                """,
                (workspace_uuid, *uuids),
            )
            result: dict[str, str] = {}
            for row in rows:
                result[row["id"]] = self._extract_plain_text(row["content"])
            return result
        finally:
            await store.close()

    async def resolve_link_targets(
        self, workspace_uuid: str, uuids: list[str]
    ) -> list[dict[str, Any]]:
        if not uuids:
            return []
        placeholders = self._placeholders(len(uuids))
        store = self._store(workspace_uuid)
        try:
            await store.sync()
            rows = await store.query(
                f"""
                SELECT n.id, n.content AS name, n.kind,
                       CASE WHEN na.node_id IS NOT NULL THEN 1 ELSE 0 END AS is_asset
                FROM node n
                LEFT JOIN node_asset na ON na.node_id = n.id
                WHERE n.workspace_id = ?
                  AND n.id IN ({placeholders})
                """,
                (workspace_uuid, *uuids),
            )
            return [
                {
                    "uuid": row["id"],
                    "name": row["name"],
                    "is_page": row["kind"] == "page",
                    "is_asset": bool(row["is_asset"]),
                }
                for row in rows
            ]
        finally:
            await store.close()

    async def get_node_properties_data(
        self, workspace_uuid: str, node_uuids: list[str]
    ) -> list[dict[str, Any]]:
        if not node_uuids:
            return []
        placeholders = self._placeholders(len(node_uuids))
        store = self._store(workspace_uuid)
        try:
            await store.sync()
            rows = await store.query(
                f"""
                SELECT
                    pv.node_id,
                    n.id AS node_uuid,
                    ps.name AS property_name,
                    ps.icon AS property_icon,
                    ps.type AS property_schema_type,
                    ps.is_system,
                    ps.multi AS is_multi,
                    ps.options AS schema_options,
                    pv.value AS value_json,
                    pv.idx AS value_index
                FROM property_value pv
                JOIN node n ON n.id = pv.node_id
                JOIN property_schema ps ON ps.id = pv.property_schema_id
                WHERE pv.node_id IN ({placeholders})
                  AND ps.active = 1
                ORDER BY pv.node_id, ps.name, pv.idx
                """,
                tuple(node_uuids),
            )
            result: list[dict[str, Any]] = []
            for row in rows:
                raw_value: Any = None
                if row["value_json"]:
                    try:
                        raw_value = json.loads(row["value_json"]).get("value")
                    except (json.JSONDecodeError, TypeError, AttributeError):
                        raw_value = None

                prop_type = self._legacy_property_type(
                    row["property_schema_type"], raw_value
                )
                entry: dict[str, Any] = {
                    "node_id": row["node_id"],
                    "node_uuid": row["node_uuid"],
                    "property_name": row["property_name"],
                    "property_icon": row["property_icon"],
                    "property_type": prop_type,
                    "is_system": bool(row["is_system"]),
                    "is_multi": bool(row["is_multi"]),
                    "value_text": None,
                    "value_boolean": None,
                    "value_float": None,
                    "value_integer": None,
                    "selection_value": None,
                    "relation_target_id": None,
                }

                if prop_type == "text":
                    if self._is_uuid(raw_value):
                        entry["relation_target_id"] = raw_value
                    else:
                        entry["value_text"] = (
                            raw_value if isinstance(raw_value, str) else None
                        )
                elif prop_type == "integer":
                    entry["value_integer"] = (
                        raw_value if isinstance(raw_value, int) else None
                    )
                elif prop_type == "float":
                    entry["value_float"] = (
                        raw_value if isinstance(raw_value, (int, float)) else None
                    )
                elif prop_type == "boolean":
                    entry["value_boolean"] = (
                        raw_value if isinstance(raw_value, bool) else None
                    )
                elif prop_type == "date":
                    entry["value_text"] = (
                        raw_value if isinstance(raw_value, str) else None
                    )
                elif prop_type == "selection":
                    options = []
                    if row["schema_options"]:
                        try:
                            options = json.loads(row["schema_options"])
                        except (json.JSONDecodeError, TypeError):
                            options = []
                    option_id = raw_value if isinstance(raw_value, str) else None
                    entry["selection_value"] = (
                        self._selection_name(options, option_id) if option_id else None
                    )
                elif prop_type == "node":
                    entry["relation_target_id"] = (
                        raw_value if isinstance(raw_value, str) else None
                    )

                result.append(entry)
            return result
        finally:
            await store.close()

    async def get_relation_target_names(
        self, workspace_uuid: str, target_uuids: list[str]
    ) -> dict[str, str]:
        if not target_uuids:
            return {}
        placeholders = self._placeholders(len(target_uuids))
        store = self._store(workspace_uuid)
        try:
            await store.sync()
            rows = await store.query(
                f"""
                SELECT id, content
                FROM node
                WHERE id IN ({placeholders})
                """,
                tuple(target_uuids),
            )
            return {
                row["id"]: self._extract_plain_text(row["content"]) for row in rows
            }
        finally:
            await store.close()

    async def get_node_class_and_tag_names(
        self, page_node_uuids: list[str], workspace_uuid: str
    ) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
        class_names: dict[str, list[str]] = {}
        tag_labels: dict[str, list[str]] = {}
        if not page_node_uuids:
            return class_names, tag_labels

        placeholders = self._placeholders(len(page_node_uuids))
        store = self._store(workspace_uuid)
        try:
            await store.sync()
            node_rows = await store.query(
                f"""
                SELECT id, class_ids
                FROM node
                WHERE id IN ({placeholders})
                """,
                tuple(page_node_uuids),
            )
            class_ids_by_node: dict[str, list[str]] = {}
            all_class_ids: set[str] = set()
            for row in node_rows:
                class_ids = self._parse_class_ids(row["class_ids"])
                class_ids_by_node[row["id"]] = class_ids
                all_class_ids.update(class_ids)

            if all_class_ids:
                class_placeholders = self._placeholders(len(all_class_ids))
                class_rows = await store.query(
                    f"""
                    SELECT id, content
                    FROM node
                    WHERE id IN ({class_placeholders})
                      AND kind = 'class'
                    """,
                    tuple(all_class_ids),
                )
                class_name_map = {
                    row["id"]: self._extract_plain_text(row["content"])
                    for row in class_rows
                }
                for node_uuid, class_ids in class_ids_by_node.items():
                    names = [
                        class_name_map[cid]
                        for cid in class_ids
                        if cid in class_name_map
                    ]
                    if names:
                        class_names[node_uuid] = names

            # Tags are not represented in the Phase 7 derived schema; return an
            # empty mapping for compatibility with the legacy export contract.
            return class_names, tag_labels
        finally:
            await store.close()

    async def get_text_property_subtrees(
        self, workspace_uuid: str, target_uuids: list[str]
    ) -> dict[str, list[dict[str, Any]]]:
        if not target_uuids:
            return {}
        placeholders = self._placeholders(len(target_uuids))
        store = self._store(workspace_uuid)
        try:
            await store.sync()
            rows = await store.query(
                f"""
                WITH RECURSIVE sub AS (
                    SELECT
                        n.id,
                        n.content,
                        n.class_ids,
                        0 AS rel_depth,
                        n.id AS root_id,
                        CAST(COALESCE(nco.position, '0') AS INTEGER) AS child_position
                    FROM node n
                    LEFT JOIN node_child_order nco ON nco.child_id = n.id
                    WHERE n.id IN ({placeholders})
                      AND n.kind != 'page'
                    UNION ALL
                    SELECT
                        n.id,
                        n.content,
                        n.class_ids,
                        s.rel_depth + 1,
                        s.root_id,
                        CAST(COALESCE(nco.position, '0') AS INTEGER) AS child_position
                    FROM node n
                    JOIN sub s ON n.parent_id = s.id
                    LEFT JOIN node_child_order nco ON nco.child_id = n.id
                    WHERE n.kind != 'page'
                )
                SELECT id, content, class_ids, rel_depth, root_id
                FROM sub
                ORDER BY root_id, rel_depth, child_position, id
                """,
                tuple(target_uuids),
            )
            text_subtrees: dict[str, list[dict[str, Any]]] = {}
            for sr in rows:
                rid = sr["root_id"]
                text_subtrees.setdefault(rid, []).append(
                    {
                        "uuid": sr["id"],
                        "name": sr["content"],
                        "_ast": parse_ast(sr["content"]),
                        "depth": sr["rel_depth"],
                        "color": None,
                        "is_page": False,
                    }
                )
            return text_subtrees
        finally:
            await store.close()

    async def get_page_metadata(
        self, workspace_uuid: str, node_uuid: str, include_properties: bool = True
    ) -> dict[str, Any]:
        store = self._store(workspace_uuid)
        try:
            await store.sync()
            node_row = await store.query(
                """
                SELECT id, kind, content, class_ids, parent_id, created_at, updated_at
                FROM node
                WHERE workspace_id = ? AND id = ?
                """,
                (workspace_uuid, node_uuid),
            )
            if not node_row:
                raise ValueError(f"Node not found: {node_uuid}")
            row = node_row[0]

            metadata: dict[str, Any] = {
                "uuid": row["id"],
                "create_date": row["created_at"],
                "write_date": row["updated_at"],
            }
            metadata["title"] = self._extract_plain_text(row["content"])

            ancestor_rows = await store.query(
                """
                WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id, 0 AS depth
                    FROM node
                    WHERE id = ?
                    UNION ALL
                    SELECT n.id, n.parent_id, a.depth + 1
                    FROM node n
                    INNER JOIN ancestors a ON n.id = a.parent_id
                )
                SELECT n.id AS uuid, n.content AS name
                FROM ancestors a
                JOIN node n ON n.id = a.id
                WHERE a.depth > 0
                ORDER BY a.depth DESC
                """,
                (row["id"],),
            )
            if ancestor_rows:
                metadata["parents"] = [
                    {
                        "uuid": ancestor["uuid"],
                        "title": self._extract_plain_text(ancestor["name"]),
                    }
                    for ancestor in ancestor_rows
                ]

            class_ids = self._parse_class_ids(row["class_ids"])
            if class_ids:
                class_placeholders = self._placeholders(len(class_ids))
                class_rows = await store.query(
                    f"""
                    SELECT id, content
                    FROM node
                    WHERE id IN ({class_placeholders})
                      AND kind = 'class'
                    """,
                    tuple(class_ids),
                )
                metadata["classes"] = [
                    {
                        "uuid": class_row["id"],
                        "name": self._extract_plain_text(class_row["content"]),
                    }
                    for class_row in class_rows
                ]

            if include_properties:
                props = await self._fetch_property_metadata(store, row["id"])
                if props:
                    metadata["properties"] = props

            return metadata
        finally:
            await store.close()

    async def _fetch_property_metadata(
        self, store: WorkspaceStore, node_uuid: str
    ) -> dict[str, Any]:
        """Aggregate active property values for a single node for frontmatter."""
        prop_rows = await store.query(
            """
            SELECT
                ps.name AS property_name,
                ps.type AS property_schema_type,
                ps.multi AS is_multi,
                ps.options AS schema_options,
                pv.value AS value_json,
                rel.id AS relation_target_id,
                rel.content AS relation_target_content
            FROM property_value pv
            JOIN property_schema ps ON ps.id = pv.property_schema_id
            LEFT JOIN node rel ON rel.id = json_extract(pv.value, '$.value')
            WHERE pv.node_id = ?
              AND ps.active = 1
            ORDER BY ps.name, pv.idx
            """,
            (node_uuid,),
        )

        props_agg: dict[str, dict[str, Any]] = {}
        for row in prop_rows:
            raw_value: Any = None
            if row["value_json"]:
                try:
                    raw_value = json.loads(row["value_json"]).get("value")
                except (json.JSONDecodeError, TypeError, AttributeError):
                    raw_value = None

            prop_type = self._legacy_property_type(
                row["property_schema_type"], raw_value
            )
            prop_name = row["property_name"]
            if prop_name not in props_agg:
                props_agg[prop_name] = {"type": prop_type, "values": []}

            value = self._property_value_to_frontmatter(
                prop_type, raw_value, row
            )
            if value is not None and value not in props_agg[prop_name]["values"]:
                props_agg[prop_name]["values"].append(value)

        props_out: dict[str, Any] = {}
        for prop_name, prop_data in props_agg.items():
            values = prop_data["values"]
            prop_type = prop_data["type"]
            if not values:
                continue
            if len(values) == 1 and prop_type != "text":
                props_out[prop_name] = values[0]
            else:
                props_out[prop_name] = values
        return props_out

    def _property_value_to_frontmatter(
        self,
        prop_type: str,
        raw_value: Any,
        row: Any,
    ) -> Any:
        if prop_type == "integer" and isinstance(raw_value, int):
            return raw_value
        if prop_type == "float" and isinstance(raw_value, (int, float)):
            return float(raw_value)
        if prop_type == "boolean" and isinstance(raw_value, bool):
            return raw_value
        if prop_type == "date" and isinstance(raw_value, str):
            return raw_value
        if prop_type == "selection":
            options = []
            if row["schema_options"]:
                try:
                    options = json.loads(row["schema_options"])
                except (json.JSONDecodeError, TypeError):
                    options = []
            option_id = raw_value if isinstance(raw_value, str) else None
            return (
                self._selection_name(options, option_id) if option_id else None
            )
        if prop_type in ("node", "text"):
            target_id = raw_value if isinstance(raw_value, str) else None
            if target_id:
                target_name = self._extract_plain_text(
                    row["relation_target_content"]
                )
                return {
                    "id": target_id,
                    "uuid": target_id,
                    "name": target_name,
                }
        if prop_type == "text" and isinstance(raw_value, str):
            return raw_value
        return None

    async def get_auto_export_metadata(
        self, workspace_uuid: str, node_uuid: str
    ) -> dict[str, Any]:
        store = self._store(workspace_uuid)
        try:
            await store.sync()
            node_rows = await store.query(
                """
                SELECT id, kind, content, class_ids, parent_id, created_at, updated_at
                FROM node
                WHERE workspace_id = ? AND id = ?
                """,
                (workspace_uuid, node_uuid),
            )
            if not node_rows:
                raise ValueError(f"Node not found: {node_uuid}")
            row = node_rows[0]

            class_ids = self._parse_class_ids(row["class_ids"])
            class_id_set = set(class_ids)

            asset_row = await store.query(
                "SELECT 1 FROM node_asset WHERE node_id = ?", (row["id"],)
            )
            is_asset = bool(asset_row) or SYSTEM_CLASS_UUIDS["asset"] in class_id_set

            date_info = parse_date_uuid(row["id"])

            metadata: dict[str, Any] = {
                "uuid": row["id"],
                "id": row["id"],
                "title": self._extract_plain_text(row["content"]),
                "is_page": row["kind"] == "page",
                "is_day": SYSTEM_CLASS_UUIDS["day"] in class_id_set
                or (date_info is not None and date_info["type"] == "day"),
                "is_month": SYSTEM_CLASS_UUIDS["month"] in class_id_set
                or (date_info is not None and date_info["type"] == "month"),
                "is_year": SYSTEM_CLASS_UUIDS["year"] in class_id_set
                or (date_info is not None and date_info["type"] == "year"),
                "is_class": row["kind"] == "class",
                "is_asset": is_asset,
                "is_template": SYSTEM_CLASS_UUIDS["template"] in class_id_set,
                "is_comment": SYSTEM_CLASS_UUIDS["comment"] in class_id_set,
                "create_date": row["created_at"],
                "write_date": row["updated_at"],
            }

            ancestor_rows = await store.query(
                """
                WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id, 0 AS depth
                    FROM node
                    WHERE id = ?
                    UNION ALL
                    SELECT n.id, n.parent_id, a.depth + 1
                    FROM node n
                    INNER JOIN ancestors a ON n.id = a.parent_id
                )
                SELECT a.depth, n.id AS uuid, n.content AS name
                FROM ancestors a
                JOIN node n ON n.id = a.id
                WHERE a.depth > 0
                ORDER BY a.depth DESC
                """,
                (row["id"],),
            )
            parents = []
            for ancestor in ancestor_rows:
                parents.append(
                    {
                        "uuid": ancestor["uuid"],
                        "title": self._extract_plain_text(ancestor["name"]),
                        "depth": ancestor["depth"],
                    }
                )
            if parents:
                metadata["parents"] = parents

            if class_ids:
                class_placeholders = self._placeholders(len(class_ids))
                class_rows = await store.query(
                    f"""
                    SELECT id, content
                    FROM node
                    WHERE id IN ({class_placeholders})
                      AND kind = 'class'
                    ORDER BY id
                    """,
                    tuple(class_ids),
                )
                metadata["classes"] = [
                    {
                        "uuid": class_row["id"],
                        "name": self._extract_plain_text(class_row["content"]),
                    }
                    for class_row in class_rows
                ]

            metadata["properties"] = await self._fetch_property_metadata(
                store, row["id"]
            )

            return metadata
        finally:
            await store.close()

    async def list_exportable_pages(
        self, workspace_uuid: str
    ) -> list[dict[str, Any]]:
        store = self._store(workspace_uuid)
        try:
            await store.sync()
            rows = await store.query(
                """
                SELECT id AS uuid, content AS name
                FROM node
                WHERE workspace_id = ?
                  AND kind = 'page'
                ORDER BY id
                """,
                (workspace_uuid,),
            )
            return [dict(row) for row in rows]
        finally:
            await store.close()

    async def resolve_node_ids(
        self, workspace_uuid: str, node_uuids: list[str]
    ) -> list[str]:
        if not node_uuids:
            return []
        placeholders = self._placeholders(len(node_uuids))
        store = self._store(workspace_uuid)
        try:
            await store.sync()
            rows = await store.query(
                f"""
                SELECT id
                FROM node
                WHERE workspace_id = ?
                  AND id IN ({placeholders})
                ORDER BY id
                """,
                (workspace_uuid, *node_uuids),
            )
            return [row["id"] for row in rows]
        finally:
            await store.close()


# Backwards-compatible alias for legacy importers/tests.
PostgresExportRepository = WorkspaceStoreExportRepository
