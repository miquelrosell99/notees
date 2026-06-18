"""PostgreSQL implementation of ExportRepository.

Contains the SQL-heavy data fetching for node export. Rendering/formatting
logic lives in app.infrastructure.export and is orchestrated by ExportService.
"""

from __future__ import annotations

from typing import Any

import asyncpg

from app.db.connection import acquire_connection
from app.domain.stringify_ast import StringifyMode, StringifyOptions, parse_ast, stringify_ast
from app.features.export.port import ExportRepository


class PostgresExportRepository(ExportRepository):
    """SQL operations backing node export."""

    def __init__(self, pool: asyncpg.Pool, workspace_id: int):
        self._pool = pool
        self._workspace_id = workspace_id

    async def get_export_node_tree(
        self, workspace_id: int, node_uuid: str, include_children: bool, include_child_pages: bool = False
    ) -> list[Any]:
        async with acquire_connection(self._pool) as conn:
            if include_children:
                page_filter = "" if include_child_pages else "AND n.is_page = FALSE"
                return await conn.fetch(
                    f"""
                    WITH RECURSIVE tree AS (
                        SELECT n.id, n.uuid, n.name, n.parent_id, n.is_page, n.color, n.class_ids,
                               0 AS depth,
                               ARRAY[n.sequence, n.id] AS path_order
                        FROM node n
                        WHERE n.workspace_id = $1 AND n.uuid::text = $2
                          AND n.is_deleted = FALSE AND n.active = TRUE
                        UNION ALL
                        SELECT n.id, n.uuid, n.name, n.parent_id, n.is_page, n.color, n.class_ids,
                               t.depth + 1,
                               t.path_order || ARRAY[n.sequence, n.id]
                        FROM node n
                        JOIN tree t ON n.parent_id = t.id
                        WHERE n.workspace_id = $1
                          AND n.is_deleted = FALSE
                          AND n.active = TRUE
                          {page_filter}
                          AND NOT EXISTS (
                              SELECT 1
                              FROM property_value_relation pvr
                              JOIN property p ON p.id = pvr.property_id
                              WHERE pvr.target_id = n.id
                                AND p.type = 'text'
                                AND p.workspace_id = $1
                          )
                    )
                    SELECT id, uuid, name, parent_id, is_page, color, class_ids, depth
                    FROM tree
                    ORDER BY path_order
                    """,
                    workspace_id,
                    node_uuid,
                )
            return await conn.fetch(
                """
                SELECT id, uuid, name, parent_id, is_page, color, class_ids
                FROM node
                WHERE workspace_id = $1 AND uuid::text = $2
                """,
                workspace_id,
                node_uuid,
            )

    async def filter_text_property_node_ids(self, node_ids: list[int]) -> set[int]:
        if not node_ids:
            return set()
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT DISTINCT pvr.target_id
                FROM property_value_relation pvr
                JOIN property p ON p.id = pvr.property_id
                WHERE pvr.target_id = ANY($1)
                  AND p.type = 'text'
                """,
                node_ids,
            )
            return {r["target_id"] for r in rows}

    async def get_system_class_map(self, workspace_id: int, uuids: list[str]) -> dict[int, str]:
        if not uuids:
            return {}
        placeholders = ", ".join(f"${i + 2}" for i in range(len(uuids)))
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                f"""
                SELECT id, name FROM node
                WHERE workspace_id = $1
                  AND is_class = TRUE
                  AND uuid::text IN ({placeholders})
                """,
                workspace_id,
                *uuids,
            )
        result: dict[int, str] = {}
        for r in rows:
            ast = parse_ast(r["name"])
            plain = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
            result[r["id"]] = plain
        return result

    async def resolve_link_targets(
        self, workspace_id: int, uuids: list[str]
    ) -> list[Any]:
        if not uuids:
            return []
        placeholders = ", ".join(f"${i + 2}" for i in range(len(uuids)))
        async with acquire_connection(self._pool) as conn:
            return await conn.fetch(
                f"""
                SELECT uuid, name, is_page, is_asset
                FROM node
                WHERE workspace_id = $1 AND uuid::text IN ({placeholders})
                """,
                workspace_id,
                *uuids,
            )

    async def get_node_properties_data(self, node_ids: list[int]) -> list[Any]:
        if not node_ids:
            return []
        async with acquire_connection(self._pool) as conn:
            return await conn.fetch(
                """
                SELECT
                    np.node_id,
                    n.uuid::text as node_uuid,
                    p.name   AS property_name,
                    p.icon   AS property_icon,
                    p.type   AS property_type,
                    p.is_system,
                    p.is_multi,
                    pvs.value_text,
                    pvs.value_boolean,
                    pvs.value_float,
                    pvs.value_integer,
                    psl.name AS selection_value,
                    pvr.target_id AS relation_target_id
                FROM node_property np
                JOIN node n ON n.id = np.node_id
                JOIN property p ON p.id = np.property_id
                LEFT JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                LEFT JOIN property_value_relation pvr ON pvr.node_property_id = np.id
                LEFT JOIN property_value_selection pvsel ON pvsel.node_property_id = np.id
                LEFT JOIN property_selection_line psl ON psl.id = pvsel.selection_line_id
                WHERE np.node_id = ANY($1)
                  AND p.active = TRUE
                ORDER BY np.node_id, p.name
                """,
                node_ids,
            )

    async def get_relation_target_names(self, target_ids: list[int]) -> dict[int, str]:
        if not target_ids:
            return {}
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT id, name FROM node WHERE id = ANY($1)",
                list(target_ids),
            )
        return {
            rr["id"]: stringify_ast(
                parse_ast(rr["name"]), StringifyOptions(mode=StringifyMode.TEXT_ONLY)
            )
            for rr in rows
        }

    async def get_node_class_and_tag_names(
        self, page_node_ids: list[int], workspace_id: int
    ) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
        class_names: dict[str, list[str]] = {}
        tag_labels: dict[str, list[str]] = {}
        if not page_node_ids:
            return class_names, tag_labels

        async with acquire_connection(self._pool) as conn:
            class_id_rows = await conn.fetch(
                """
                SELECT id, uuid::text as uuid, class_ids
                FROM node
                WHERE id = ANY($1) AND class_ids != '{}'
                """,
                page_node_ids,
            )
            if class_id_rows:
                all_class_ids = list({cid for r in class_id_rows for cid in (r["class_ids"] or [])})
                class_name_rows = await conn.fetch(
                    "SELECT id, name FROM node WHERE id = ANY($1) AND active = TRUE",
                    all_class_ids,
                )
                class_name_map = {
                    r["id"]: stringify_ast(
                        parse_ast(r["name"]),
                        StringifyOptions(mode=StringifyMode.TEXT_ONLY),
                    )
                    for r in class_name_rows
                }
                for r in class_id_rows:
                    node_uuid_key = r["uuid"]
                    names = [
                        class_name_map[cid]
                        for cid in (r["class_ids"] or [])
                        if cid in class_name_map
                    ]
                    if names:
                        class_names[node_uuid_key] = names

            tag_rows = await conn.fetch(
                """
                SELECT n.id as source_id, n.uuid::text as source_uuid, t.name as tag_name
                FROM node n
                JOIN node t ON t.id = ANY(n.tag_ids)
                WHERE n.id = ANY($1)
                  AND n.workspace_id = $2
                  AND array_length(n.tag_ids, 1) > 0
                ORDER BY n.id, t.name
                """,
                page_node_ids,
                workspace_id,
            )
            for r in tag_rows:
                node_uuid_key = r["source_uuid"]
                tag_label = stringify_ast(
                    parse_ast(r["tag_name"]),
                    StringifyOptions(mode=StringifyMode.TEXT_ONLY),
                )
                tag_labels.setdefault(node_uuid_key, []).append(tag_label)

        return class_names, tag_labels

    async def get_text_property_subtrees(
        self, target_ids: list[int]
    ) -> dict[int, list[dict[str, Any]]]:
        if not target_ids:
            return {}
        async with acquire_connection(self._pool) as conn:
            sub_rows = await conn.fetch(
                """
                WITH RECURSIVE sub AS (
                    SELECT n.id, n.uuid::text as uuid, n.name, n.color,
                           0 AS rel_depth, n.id AS root_id,
                           ARRAY[n.sequence, n.id] AS path_order
                    FROM node n
                    WHERE n.id = ANY($1)
                      AND n.active = TRUE AND n.is_deleted = FALSE
                    UNION ALL
                    SELECT n.id, n.uuid::text as uuid, n.name, n.color,
                           s.rel_depth + 1, s.root_id,
                           s.path_order || ARRAY[n.sequence, n.id]
                    FROM node n
                    JOIN sub s ON n.parent_id = s.id
                    WHERE n.active = TRUE AND n.is_deleted = FALSE
                      AND n.is_page = FALSE
                )
                SELECT id, uuid, name, color, rel_depth, root_id
                FROM sub ORDER BY root_id, path_order
                """,
                target_ids,
            )
        text_subtrees: dict[int, list[dict[str, Any]]] = {}
        for sr in sub_rows:
            rid = sr["root_id"]
            text_subtrees.setdefault(rid, []).append(
                {
                    "uuid": sr["uuid"],
                    "name": sr["name"],
                    "_ast": parse_ast(sr["name"]),
                    "depth": sr["rel_depth"],
                    "color": sr.get("color"),
                    "is_page": False,
                }
            )
        return text_subtrees

    async def get_page_metadata(
        self, workspace_id: int, node_uuid: str, include_properties: bool = True
    ) -> dict[str, Any]:
        async with acquire_connection(self._pool) as conn:
            node_row = await conn.fetchrow(
                """
                SELECT id, uuid::text as uuid, name, is_page, is_day, is_month, is_year,
                       color, icon, class_ids, tag_ids, parent_id, create_date, write_date
                FROM node
                WHERE workspace_id = $1 AND uuid::text = $2
                """,
                workspace_id,
                node_uuid,
            )
            if not node_row:
                raise ValueError(f"Node not found: {node_uuid}")

            metadata: dict[str, Any] = {
                "uuid": str(node_row["uuid"]),
                "create_date": node_row["create_date"].isoformat() if node_row["create_date"] else None,
                "write_date": node_row["write_date"].isoformat() if node_row["write_date"] else None,
            }

            metadata["title"] = self._extract_plain_text(node_row["name"])

            if node_row["color"]:
                metadata["color"] = node_row["color"]

            ancestor_rows = await conn.fetch(
                """
                WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id, 0 AS depth
                    FROM node
                    WHERE id = $1
                    UNION ALL
                    SELECT n.id, n.parent_id, a.depth + 1
                    FROM node n
                    INNER JOIN ancestors a ON n.id = a.parent_id
                )
                SELECT n.uuid::text as uuid, n.name
                FROM ancestors a
                JOIN node n ON n.id = a.id
                WHERE a.depth > 0
                ORDER BY a.depth DESC
                """,
                node_row["id"],
            )
            if ancestor_rows:
                metadata["parents"] = [
                    {"uuid": str(row["uuid"]), "title": self._extract_plain_text(row["name"])}
                    for row in ancestor_rows
                ]

            tag_rows = await conn.fetch(
                """
                SELECT n.uuid::text as uuid, n.name
                FROM node n
                WHERE n.id = ANY($1) AND n.active = TRUE
                ORDER BY n.name
                """,
                list(node_row["tag_ids"] or []),
            )
            if tag_rows:
                metadata["tags"] = [
                    {"uuid": str(row["uuid"]), "name": self._extract_plain_text(row["name"])}
                    for row in tag_rows
                ]

            class_ids = list(node_row["class_ids"] or [])
            if class_ids:
                class_rows = await conn.fetch(
                    "SELECT id, uuid::text as uuid, name FROM node WHERE id = ANY($1) AND active = TRUE",
                    class_ids,
                )
                metadata["classes"] = [
                    {"uuid": str(row["uuid"]), "name": self._extract_plain_text(row["name"])}
                    for row in class_rows
                ]

            if include_properties:
                prop_rows = await conn.fetch(
                    """
                    SELECT p.name AS property_name, p.type AS property_type, p.is_multi,
                           pvs.value_text, pvs.value_boolean, pvs.value_float, pvs.value_integer,
                           psl.name AS selection_value,
                           pvr.target_id AS relation_target_id,
                           rel.uuid::text AS relation_target_uuid, rel.name AS relation_target_name
                    FROM node_property np
                    JOIN property p ON p.id = np.property_id
                    LEFT JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                    LEFT JOIN property_value_relation pvr ON pvr.node_property_id = np.id
                    LEFT JOIN property_value_selection pvsel ON pvsel.node_property_id = np.id
                    LEFT JOIN property_selection_line psl ON psl.id = pvsel.selection_line_id
                    LEFT JOIN node rel ON rel.id = pvr.target_id
                    WHERE np.node_id = $1 AND p.active = TRUE
                    ORDER BY p.name
                    """,
                    node_row["id"],
                )
                props_agg: dict[str, dict] = {}
                for row in prop_rows:
                    prop_name = row["property_name"]
                    prop_type = row["property_type"]
                    if prop_name not in props_agg:
                        props_agg[prop_name] = {"type": prop_type, "values": []}
                    value = None
                    if prop_type == "integer" and row["value_integer"] is not None:
                        value = row["value_integer"]
                    elif prop_type == "float" and row["value_float"] is not None:
                        value = row["value_float"]
                    elif prop_type == "boolean" and row["value_boolean"] is not None:
                        value = bool(row["value_boolean"])
                    elif prop_type == "date" and row["value_text"] is not None:
                        value = row["value_text"]
                    elif prop_type == "selection" and row["selection_value"] is not None:
                        value = row["selection_value"]
                    elif prop_type in ("node", "text") and row["relation_target_id"] is not None:
                        value = {
                            "uuid": str(row["relation_target_uuid"]) if row["relation_target_uuid"] else None,
                            "name": self._extract_plain_text(row["relation_target_name"]),
                        }
                    if value is not None and value not in props_agg[prop_name]["values"]:
                        props_agg[prop_name]["values"].append(value)

                if props_agg:
                    props_out = {}
                    for prop_name, prop_data in props_agg.items():
                        values = prop_data["values"]
                        prop_type = prop_data["type"]
                        if not values:
                            continue
                        if len(values) == 1 and prop_type != "text":
                            props_out[prop_name] = values[0]
                        else:
                            props_out[prop_name] = values
                    if props_out:
                        metadata["properties"] = props_out

            if node_row["icon"]:
                metadata["icon"] = node_row["icon"]

            return metadata

    @staticmethod
    def _extract_plain_text(name: str | None) -> str:
        if not name:
            return "untitled"
        try:
            ast = parse_ast(name)
            opts = StringifyOptions(mode=StringifyMode.TEXT_ONLY)
            return stringify_ast(ast, opts) or "untitled"
        except (ValueError, TypeError):
            return name.strip() or "untitled"

    async def get_auto_export_metadata(
        self, workspace_id: int, node_uuid: str
    ) -> dict[str, Any]:
        """Fetch node metadata for auto-export YAML frontmatter."""
        async with acquire_connection(self._pool) as conn:
            node_row = await conn.fetchrow(
                """
                SELECT id, uuid::text as uuid, name, is_page, is_day, is_month, is_year,
                       is_class, is_asset, is_template, is_comment, color, icon, class_ids, tag_ids,
                       parent_id, create_date, write_date
                FROM node
                WHERE workspace_id = $1 AND uuid::text = $2
                """,
                workspace_id,
                node_uuid,
            )
            if not node_row:
                raise ValueError(f"Node not found: {node_uuid}")

            metadata: dict[str, Any] = {
                "uuid": str(node_row["uuid"]),
                "id": node_row["id"],
                "title": self._extract_plain_text(node_row["name"]),
                "is_page": node_row["is_page"],
                "is_day": node_row["is_day"],
                "is_month": node_row["is_month"],
                "is_year": node_row["is_year"],
                "is_class": node_row["is_class"],
                "is_asset": node_row["is_asset"],
                "is_template": node_row["is_template"],
                "is_comment": node_row["is_comment"],
                "create_date": node_row["create_date"].isoformat() if node_row["create_date"] else None,
                "write_date": node_row["write_date"].isoformat() if node_row["write_date"] else None,
            }

            ancestor_rows = await conn.fetch(
                """
                WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id, 0 AS depth
                    FROM node
                    WHERE id = $1
                    UNION ALL
                    SELECT n.id, n.parent_id, a.depth + 1
                    FROM node n
                    INNER JOIN ancestors a ON n.id = a.parent_id
                )
                SELECT a.id as ancestor_id, a.depth, n.uuid::text as uuid, n.name
                FROM ancestors a
                JOIN node n ON n.id = a.id
                WHERE a.depth > 0
                ORDER BY a.depth DESC
                """,
                node_row["id"],
            )
            parents = []
            for row in ancestor_rows:
                parents.append(
                    {
                        "uuid": str(row["uuid"]),
                        "title": self._extract_plain_text(row["name"]),
                        "depth": row["depth"],
                    }
                )
            if parents:
                metadata["parents"] = parents

            tag_rows = await conn.fetch(
                """
                SELECT n.uuid::text as uuid, n.name
                FROM node n
                WHERE n.id = ANY($1) AND n.active = TRUE
                ORDER BY n.name
                """,
                list(node_row["tag_ids"] or []),
            )
            if tag_rows:
                metadata["tags"] = [
                    {"uuid": str(row["uuid"]), "name": self._extract_plain_text(row["name"])}
                    for row in tag_rows
                ]

            class_ids = list(node_row["class_ids"] or [])
            if class_ids:
                class_rows = await conn.fetch(
                    """
                    SELECT id, uuid::text as uuid, name
                    FROM node
                    WHERE id = ANY($1) AND active = TRUE
                    ORDER BY array_position($1, id)
                    """,
                    class_ids,
                )
                metadata["classes"] = [
                    {"uuid": str(row["uuid"]), "name": self._extract_plain_text(row["name"])}
                    for row in class_rows
                ]

            prop_rows = await conn.fetch(
                """
                SELECT
                    p.name AS property_name,
                    p.type AS property_type,
                    p.is_multi,
                    pvs.value_text,
                    pvs.value_boolean,
                    pvs.value_float,
                    pvs.value_integer,
                    psl.name AS selection_value,
                    pvr.target_id AS relation_target_id,
                    rel.uuid::text AS relation_target_uuid,
                    rel.name AS relation_target_name
                FROM node_property np
                JOIN property p ON p.id = np.property_id
                LEFT JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                LEFT JOIN property_value_relation pvr ON pvr.node_property_id = np.id
                LEFT JOIN property_value_selection pvsel ON pvsel.node_property_id = np.id
                LEFT JOIN property_selection_line psl ON psl.id = pvsel.selection_line_id
                LEFT JOIN node rel ON rel.id = pvr.target_id
                WHERE np.node_id = $1
                  AND p.active = TRUE
                ORDER BY p.name
                """,
                node_row["id"],
            )

            props_agg: dict[str, dict] = {}
            for row in prop_rows:
                prop_name = row["property_name"]
                prop_type = row["property_type"]
                if prop_name not in props_agg:
                    props_agg[prop_name] = {
                        "type": prop_type,
                        "values": [],
                    }

                value = None
                if prop_type == "integer" and row["value_integer"] is not None:
                    value = row["value_integer"]
                elif prop_type == "float" and row["value_float"] is not None:
                    value = row["value_float"]
                elif prop_type == "boolean" and row["value_boolean"] is not None:
                    value = bool(row["value_boolean"])
                elif prop_type == "date" and row["value_text"] is not None:
                    value = row["value_text"]
                elif prop_type == "selection" and row["selection_value"] is not None:
                    value = row["selection_value"]
                elif prop_type in ("node", "text") and row["relation_target_id"] is not None:
                    value = {
                        "id": row["relation_target_id"],
                        "uuid": str(row["relation_target_uuid"]) if row["relation_target_uuid"] else None,
                        "name": self._extract_plain_text(row["relation_target_name"]),
                    }
                elif prop_type == "text" and row["value_text"] is not None:
                    value = row["value_text"]

                if value is not None and value not in props_agg[prop_name]["values"]:
                    props_agg[prop_name]["values"].append(value)

            if props_agg:
                props_out = {}
                for prop_name, prop_data in props_agg.items():
                    values = prop_data["values"]
                    prop_type = prop_data["type"]
                    if not values:
                        continue
                    if len(values) == 1 and prop_type != "text":
                        props_out[prop_name] = values[0]
                    else:
                        props_out[prop_name] = values
                if props_out:
                    metadata["properties"] = props_out

            if node_row["icon"]:
                metadata["icon"] = node_row["icon"]

            return metadata

    async def list_exportable_pages(
        self, workspace_id: int
    ) -> list[dict[str, Any]]:
        """List active non-deleted page UUIDs and names for batch export."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT uuid::text as uuid, name
                FROM node
                WHERE workspace_id = $1
                  AND is_page = TRUE
                  AND is_deleted = FALSE
                  AND active = TRUE
                ORDER BY id
                """,
                workspace_id,
            )
        return [dict(r) for r in rows]
