"""Domain service for node export.

Orchestrates SQL-backed data fetching (via ExportRepository) with the
pure-Python rendering helpers that remain in app.node_export.
"""

from __future__ import annotations

from typing import Any

from ...domain.repositories.interfaces import ExportRepository


class ExportService:
    """Service facade for node export operations."""

    def __init__(self, export_repo: ExportRepository):
        self._export_repo = export_repo

    async def get_export_node_tree(
        self, workspace_id: int, node_uuid: str, include_children: bool, include_child_pages: bool = False
    ) -> list[dict[str, Any]]:
        """Fetch a node tree ready for export rendering."""
        rows = await self._export_repo.get_export_node_tree(
            workspace_id, node_uuid, include_children, include_child_pages
        )
        nodes_data: list[dict[str, Any]] = []
        for row in rows:
            row_uuid = str(row["uuid"])
            nodes_data.append(
                {
                    "id": row["id"],
                    "uuid": row_uuid,
                    "name": row["name"],
                    "is_page": row.get("is_page", False),
                    "color": row.get("color") or None,
                    "depth": row.get("depth", 0) if include_children else 0,
                    "class_ids": row.get("class_ids") or [],
                }
            )
        return nodes_data

    async def filter_text_property_nodes(
        self, nodes_data: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Remove text-property subtrees from the export node list."""
        if len(nodes_data) <= 1:
            return nodes_data
        all_tree_ids = [nd["id"] for nd in nodes_data]
        text_prop_ids = await self._export_repo.filter_text_property_node_ids(all_tree_ids)
        if not text_prop_ids:
            return nodes_data

        filtered: list[dict[str, Any]] = []
        skip_depth: int | None = None
        for nd in nodes_data:
            if skip_depth is not None:
                if nd["depth"] > skip_depth:
                    continue
                skip_depth = None
            if nd["id"] in text_prop_ids:
                skip_depth = nd["depth"]
                continue
            filtered.append(nd)
        return filtered

    async def get_system_class_maps(
        self, workspace_id: int
    ) -> tuple[int | None, int | None, dict[int, str]]:
        """Resolve code/quote/callout class IDs for rendering."""
        system_uuids = [
            "00000000-0000-0000-0001-000000000008",
            "00000000-0000-0000-0001-000000000006",
            "00000000-0000-0000-0001-000000000016",
            "00000000-0000-0000-0001-000000000017",
            "00000000-0000-0000-0001-000000000018",
            "00000000-0000-0000-0001-000000000019",
            "00000000-0000-0000-0001-000000000020",
            "00000000-0000-0000-0001-000000000021",
        ]
        system_class_map = await self._export_repo.get_system_class_map(
            workspace_id, system_uuids
        )
        code_class_id: int | None = None
        quote_class_id: int | None = None
        callout_class_map: dict[int, str] = {}
        for cid, cname in system_class_map.items():
            if cname == "code":
                code_class_id = cid
            elif cname == "quote":
                quote_class_id = cid
            elif cname in ("warning", "note", "tip", "info", "danger", "success"):
                callout_class_map[cid] = cname
        return code_class_id, quote_class_id, callout_class_map

    async def resolve_link_targets(
        self, workspace_id: int, target_uuids: set[str]
    ) -> tuple[dict[str, list], dict[str, bool], dict[str, bool]]:
        """Resolve AST + flags for a set of link target UUIDs."""
        from ...domain.stringify_ast import parse_ast

        link_target_map: dict[str, list] = {}
        link_is_page_map: dict[str, bool] = {}
        link_is_asset_map: dict[str, bool] = {}
        if target_uuids:
            rows = await self._export_repo.resolve_link_targets(
                workspace_id, list(target_uuids)
            )
            for tr in rows:
                link_target_map[str(tr["uuid"])] = parse_ast(tr["name"])
                link_is_page_map[str(tr["uuid"])] = bool(tr["is_page"])
                link_is_asset_map[str(tr["uuid"])] = bool(tr["is_asset"])
        return link_target_map, link_is_page_map, link_is_asset_map

    async def get_properties_data(
        self, property_target_nodes: list[dict[str, Any]], workspace_id: int
    ) -> tuple[dict[str, list], set[str]]:
        """Build the properties_data map for the given target nodes."""


        properties_data: dict[str, list] = {}
        if not property_target_nodes:
            return properties_data

        page_node_ids = [nd["id"] for nd in property_target_nodes if nd.get("id")]
        if not page_node_ids:
            return properties_data

        prop_rows = await self._export_repo.get_node_properties_data(page_node_ids)
        relation_target_ids = {row["relation_target_id"] for row in prop_rows if row["relation_target_id"]}
        relation_target_names = await self._export_repo.get_relation_target_names(
            list(relation_target_ids)
        )

        agg: dict[str, dict[str, dict]] = {}
        for row in prop_rows:
            node_uuid_key = row["node_uuid"]
            prop_name = row["property_name"]
            prop_type = row["property_type"]
            if node_uuid_key not in agg:
                agg[node_uuid_key] = {}
            if prop_name not in agg[node_uuid_key]:
                agg[node_uuid_key][prop_name] = {
                    "name": prop_name,
                    "icon": row["property_icon"],
                    "type": prop_type,
                    "values": [],
                }
            entry = agg[node_uuid_key][prop_name]
            value_str: str | None = None
            if prop_type == "integer" and row["value_integer"] is not None:
                value_str = str(row["value_integer"])
            elif prop_type == "float" and row["value_float"] is not None:
                value_str = str(row["value_float"])
            elif prop_type == "boolean" and row["value_boolean"] is not None:
                value_str = "Yes" if row["value_boolean"] else "No"
            elif prop_type == "date" and row["value_text"] is not None:
                value_str = row["value_text"]
            elif prop_type == "node" and row["relation_target_id"] is not None:
                value_str = relation_target_names.get(row["relation_target_id"])
            elif prop_type == "text" and row["relation_target_id"] is not None:
                value_str = relation_target_names.get(row["relation_target_id"])
                if "target_ids" not in entry:
                    entry["target_ids"] = []
                tid = row["relation_target_id"]
                if tid not in entry["target_ids"]:
                    entry["target_ids"].append(tid)
            elif prop_type == "selection" and row["selection_value"] is not None:
                value_str = row["selection_value"]
            if value_str is not None and value_str not in entry["values"]:
                entry["values"].append(value_str)

        class_names, tag_labels = await self._export_repo.get_node_class_and_tag_names(
            page_node_ids, workspace_id
        )
        for node_uuid_key, names in class_names.items():
            if names:
                if node_uuid_key not in agg:
                    agg[node_uuid_key] = {}
                agg[node_uuid_key]["classes"] = {
                    "name": "classes",
                    "icon": None,
                    "type": "classes",
                    "values": names,
                }
        for node_uuid_key, labels in tag_labels.items():
            if labels:
                if node_uuid_key not in agg:
                    agg[node_uuid_key] = {}
                if "tags" not in agg[node_uuid_key]:
                    agg[node_uuid_key]["tags"] = {
                        "name": "tags",
                        "icon": None,
                        "type": "tags",
                        "values": [],
                    }
                for tag_label in labels:
                    if tag_label not in agg[node_uuid_key]["tags"]["values"]:
                        agg[node_uuid_key]["tags"]["values"].append(tag_label)

        # Text property subtrees
        all_text_target_ids = [
            tid
            for props in agg.values()
            for pe in props.values()
            if pe["type"] == "text" and "target_ids" in pe
            for tid in pe["target_ids"]
        ]
        text_subtrees = await self._export_repo.get_text_property_subtrees(
            all_text_target_ids
        )
        for props in agg.values():
            for pe in props.values():
                if pe["type"] == "text" and "target_ids" in pe:
                    pe["subtree"] = []
                    for tid in pe["target_ids"]:
                        pe["subtree"].extend(text_subtrees.get(tid, []))

        # Resolve any new link targets inside text subtrees
        subtree_link_uuids: set[str] = set()
        for nd_list in text_subtrees.values():
            for nd in nd_list:
                self._collect_link_target_uuids(nd["_ast"], subtree_link_uuids)

        for node_uuid_key, props in agg.items():
            pinned = [p for p in props.values() if p["type"] in ("classes", "tags")]
            rest = sorted(
                [p for p in props.values() if p["type"] not in ("classes", "tags")],
                key=lambda p: p["name"],
            )
            properties_data[node_uuid_key] = pinned + rest

        return properties_data, subtree_link_uuids

    @staticmethod
    def _collect_link_target_uuids(ast_nodes: list, out: set[str]) -> None:
        """Recursively walk AST nodes and collect link target UUIDs."""
        for node in ast_nodes:
            if not isinstance(node, dict):
                continue
            if node.get("type") == "node_link":
                link_id = node.get("link_id", "")
                colon = link_id.find(":")
                node_uuid = link_id[:colon] if colon > 0 else link_id
                if node_uuid:
                    out.add(node_uuid)
            children = node.get("children")
            if children:
                ExportService._collect_link_target_uuids(children, out)

    async def get_page_metadata(
        self, workspace_id: int, node_uuid: str, include_properties: bool = True
    ) -> dict[str, Any]:
        """Fetch full page metadata for YAML frontmatter."""
        return await self._export_repo.get_page_metadata(
            workspace_id, node_uuid, include_properties=include_properties
        )
