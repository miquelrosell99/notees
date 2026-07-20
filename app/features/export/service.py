"""Domain service for node export.

Orchestrates SQL-backed data fetching (via ExportRepository) with the
rendering adapter behind the NodeExportRenderer port.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.domain.converters import JsonAstConverter, MarkdownConverter, PlainTextConverter
from app.domain.ports import NodeExportRenderer
from app.domain.stringify_ast import NodeLinkResolution, parse_ast
from app.features.export.port import ExportRepository
from app.logging_config import get_logger
from app.plugins.core.context import PluginContext
from app.plugins.core.manager import plugin_manager
from app.plugins.core.ports import ExportContext

logger = get_logger(__name__)


class ExportService:
    """Service facade for node export operations."""

    def __init__(self, export_repo: ExportRepository, renderer: NodeExportRenderer):
        self._export_repo = export_repo
        self._renderer = renderer

    async def get_export_node_tree(
        self, workspace_uuid: str, node_uuid: str, include_children: bool, include_child_pages: bool = False
    ) -> list[dict[str, Any]]:
        """Fetch a node tree ready for export rendering."""
        rows = await self._export_repo.get_export_node_tree(
            workspace_uuid, node_uuid, include_children, include_child_pages
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
        self, workspace_uuid: str, nodes_data: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Remove text-property subtrees from the export node list."""
        if len(nodes_data) <= 1:
            return nodes_data
        all_tree_ids = [nd["id"] for nd in nodes_data]
        text_prop_ids = await self._export_repo.filter_text_property_node_ids(
            workspace_uuid, all_tree_ids
        )
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
        self, workspace_uuid: str
    ) -> tuple[str | None, str | None, dict[str, str]]:
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
            workspace_uuid, system_uuids
        )
        code_class_id: str | None = None
        quote_class_id: str | None = None
        callout_class_map: dict[str, str] = {}
        for cid, cname in system_class_map.items():
            if cname == "code":
                code_class_id = cid
            elif cname == "quote":
                quote_class_id = cid
            elif cname in ("warning", "note", "tip", "info", "danger", "success"):
                callout_class_map[cid] = cname
        return code_class_id, quote_class_id, callout_class_map

    async def resolve_link_targets(
        self, workspace_uuid: str, target_uuids: set[str]
    ) -> tuple[dict[str, list], dict[str, bool], dict[str, bool]]:
        """Resolve AST + flags for a set of link target UUIDs."""
        from app.domain.stringify_ast import parse_ast

        link_target_map: dict[str, list] = {}
        link_is_page_map: dict[str, bool] = {}
        link_is_asset_map: dict[str, bool] = {}
        if target_uuids:
            rows = await self._export_repo.resolve_link_targets(
                workspace_uuid, list(target_uuids)
            )
            for tr in rows:
                link_target_map[str(tr["uuid"])] = parse_ast(tr["name"])
                link_is_page_map[str(tr["uuid"])] = bool(tr["is_page"])
                link_is_asset_map[str(tr["uuid"])] = bool(tr["is_asset"])
        return link_target_map, link_is_page_map, link_is_asset_map

    async def get_properties_data(
        self, property_target_nodes: list[dict[str, Any]], workspace_uuid: str
    ) -> tuple[dict[str, list], set[str]]:
        """Build the properties_data map for the given target nodes."""


        properties_data: dict[str, list] = {}
        if not property_target_nodes:
            return properties_data

        page_node_ids = [nd["id"] for nd in property_target_nodes if nd.get("id")]
        if not page_node_ids:
            return properties_data

        prop_rows = await self._export_repo.get_node_properties_data(
            workspace_uuid, page_node_ids
        )
        relation_target_ids = {row["relation_target_id"] for row in prop_rows if row["relation_target_id"]}
        relation_target_names = await self._export_repo.get_relation_target_names(
            workspace_uuid, list(relation_target_ids)
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
            page_node_ids, workspace_uuid
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
            workspace_uuid, all_text_target_ids
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
        self, workspace_uuid: str, node_uuid: str, include_properties: bool = True
    ) -> dict[str, Any]:
        """Fetch full page metadata for YAML frontmatter."""
        return await self._export_repo.get_page_metadata(
            workspace_uuid, node_uuid, include_properties=include_properties
        )

    async def get_auto_export_metadata(
        self, workspace_uuid: str, node_uuid: str
    ) -> dict[str, Any]:
        """Fetch node metadata for auto-export YAML frontmatter."""
        return await self._export_repo.get_auto_export_metadata(
            workspace_uuid, node_uuid
        )

    async def export_nodes(
        self,
        workspace_uuid: str,
        node_uuids: list[str],
        format: Any,
        user_id: int | None = None,
        include_children: bool = True,
        layout: str = "outline",
        formatting: bool = True,
        style: str | None = None,
        properties: str = "none",
        density: str = "comfortable",
        numbering: str = "none",
        measure: str = "full",
        doctype: str = "none",
        section_break: bool = False,
        show_uuid: bool = False,
        link_style: str = "raw",
        theme_mode: str = "light",
        cover_page: bool = False,
        page_size: str = "a4",
        include_child_pages: bool = False,
        asset_path_map: dict[str, str] | None = None,
        highlight_syntax: bool = True,
        link_target_brackets: bool = True,
        frontmatter: bool = False,
    ) -> tuple[bytes, str, str]:
        """Export nodes to Markdown, HTML, PDF, Text, JSON, or a plugin format.

        Args:
            workspace_uuid: Workspace ID to export from.
            node_uuids: List of node UUIDs to export.
            format: Export format (markdown, html, pdf, text, json).
            asset_path_map: Optional dict mapping asset node UUIDs to relative
                file paths (e.g. './assets/uuid/filename.ext').

        Returns:
            Tuple of (content: bytes, filename: str, mime_type: str)

        Raises:
            ValueError: If no nodes found.
        """
        nodes_data: list[dict[str, Any]] = []
        seen_uuids: set[str] = set()
        for node_uuid in node_uuids:
            fetched = await self.get_export_node_tree(
                workspace_uuid, node_uuid, include_children, include_child_pages
            )
            for nd in fetched:
                row_uuid = nd["uuid"]
                if row_uuid in seen_uuids:
                    continue
                seen_uuids.add(row_uuid)
                nodes_data.append(nd)

        if not nodes_data:
            raise ValueError("No nodes found to export")

        # Determine which nodes should have properties fetched BEFORE any
        # stripping/filtering so that "main" always refers to the originally
        # requested root nodes, not whatever happens to be at depth 0 later.
        property_target_nodes: list[dict[str, Any]] = []
        if properties == "main":
            property_target_nodes = [nd for nd in nodes_data if nd.get("depth", 0) == 0]
        elif properties == "all":
            property_target_nodes = nodes_data

        fmt_str = str(format).lower()

        # Delegate to a plugin exporter if one registered for this format.
        exporter_reg = plugin_manager.get_exporter_registration(fmt_str)
        if exporter_reg is not None:
            plugin_id, adapter = exporter_reg
            resolved_ids = await self._export_repo.resolve_node_ids(workspace_uuid, node_uuids)
            if not resolved_ids:
                raise ValueError("No nodes found to export")

            loaded_plugin = plugin_manager.get_plugin(plugin_id)
            if loaded_plugin is None:
                raise ValueError(f"Plugin {plugin_id} is not loaded")

            plugin_context = PluginContext(
                plugin_id=plugin_id,
                permissions=set(loaded_plugin.manifest.permissions),
                registry=plugin_manager.registry,
                port_factories=plugin_manager.port_factories,
            )
            options = {
                "include_children": include_children,
                "include_child_pages": include_child_pages,
                "layout": layout,
                "formatting": formatting,
                "style": style,
                "properties": properties,
                "density": density,
                "numbering": numbering,
                "measure": measure,
                "doctype": doctype,
                "section_break": section_break,
                "show_uuid": show_uuid,
                "link_style": link_style,
                "theme_mode": theme_mode,
                "cover_page": cover_page,
                "page_size": page_size,
            }
            result = await adapter.export_nodes(
                ExportContext(
                    node_ids=resolved_ids,
                    workspace_uuid=workspace_uuid,
                    user_id=user_id or 0,
                    plugin_context=plugin_context,
                    options=options,
                    nodes_data=nodes_data,
                )
            )
            return result.content, result.filename, result.mime_type

        # Automatically skip the root page node for Markdown exports.
        if fmt_str == "markdown" and nodes_data and nodes_data[0].get("is_page", False) and include_children:
            nodes_data = [nd for nd in nodes_data if nd.get("depth", 0) > 0]
            for nd in nodes_data:
                nd["depth"] = max(0, nd["depth"] - 1)
            # Empty pages are valid: the Markdown body is simply empty and the
            # caller (e.g. auto-export) adds frontmatter separately.

        # Filter out text property value blocks (post-query safety net)
        if include_children and len(nodes_data) > 1:
            nodes_data = await self.filter_text_property_nodes(workspace_uuid, nodes_data)

        # Look up system class IDs for code / quote / callout rendering
        code_class_id, quote_class_id, callout_class_map = await self.get_system_class_maps(workspace_uuid)

        # Resolve node links in all ASTs
        target_uuids: set[str] = set()
        for nd in nodes_data:
            ast = parse_ast(nd["name"])
            nd["_ast"] = ast
            self._collect_link_target_uuids(ast, target_uuids)

        link_target_map, link_is_page_map, link_is_asset_map = await self.resolve_link_targets(
            workspace_uuid, target_uuids
        )

        def resolve_node_link(link_id: str):
            colon = link_id.find(":")
            node_uuid = link_id[:colon] if colon > 0 else link_id
            target_ast = link_target_map.get(node_uuid)
            if target_ast is None:
                return None
            return NodeLinkResolution(
                target_ast=target_ast,
                label=None,
                target_id=node_uuid,
                is_page=link_is_page_map.get(node_uuid),
                is_asset=link_is_asset_map.get(node_uuid, False),
                asset_path=asset_path_map.get(node_uuid) if asset_path_map else None,
            )

        # Fetch properties for target nodes if requested
        properties_data: dict[str, list] = {}
        if property_target_nodes:
            properties_data, subtree_link_uuids = await self.get_properties_data(
                property_target_nodes, workspace_uuid
            )
            if subtree_link_uuids:
                extra_map, extra_is_page, _ = await self.resolve_link_targets(
                    workspace_uuid, subtree_link_uuids
                )
                link_target_map.update(extra_map)
                link_is_page_map.update(extra_is_page)

        if show_uuid and properties != "none":
            for nd in nodes_data:
                uuid_val = nd.get("uuid", "")
                if not uuid_val:
                    continue
                if nd.get("depth", 0) == 0 or properties == "all":
                    uuid_prop = {"name": "uuid", "icon": None, "type": "text", "values": [uuid_val]}
                    existing = properties_data.get(uuid_val, [])
                    properties_data[uuid_val] = [uuid_prop] + [p for p in existing if p["name"] != "uuid"]

        strip_links = link_style == "text"

        cover_metadata = None
        if cover_page and node_uuids and fmt_str in {"html", "pdf"}:
            cover_metadata = await self.get_page_metadata(
                workspace_uuid, node_uuids[0], include_properties=False
            )

        if fmt_str == "markdown":
            content = MarkdownConverter().convert(
                nodes_data,
                resolve_node_link,
                layout,
                formatting,
                properties_data,
                strip_link_syntax=strip_links,
                code_class_id=code_class_id,
                quote_class_id=quote_class_id,
                callout_class_map=callout_class_map,
                highlight_syntax=highlight_syntax,
                link_target_brackets=link_target_brackets,
            )
            if frontmatter and node_uuids:
                root_uuid = node_uuids[0]
                metadata = await self.get_page_metadata(
                    workspace_uuid, root_uuid, include_properties=properties != "none"
                )
                content = self._renderer.build_yaml_frontmatter(metadata) + content
            filename = "export.md"
            mime_type = "text/markdown"
        elif fmt_str == "text":
            content = PlainTextConverter().convert(
                nodes_data,
                resolve_node_link,
                layout,
                formatting,
                properties_data,
                strip_link_syntax=strip_links,
                code_class_id=code_class_id,
                quote_class_id=quote_class_id,
                callout_class_map=callout_class_map,
            )
            filename = "export.txt"
            mime_type = "text/plain"
        elif fmt_str == "json":
            content = JsonAstConverter().convert(
                nodes_data,
                resolve_node_link,
                layout,
                formatting,
                properties_data,
                strip_link_syntax=strip_links,
                code_class_id=code_class_id,
                quote_class_id=quote_class_id,
                callout_class_map=callout_class_map,
            )
            filename = "export.json"
            mime_type = "application/json"
        elif fmt_str == "html":
            content = await self._renderer.render_html(
                nodes_data,
                resolve_node_link,
                layout,
                formatting,
                style,
                properties_data,
                density,
                numbering,
                measure,
                doctype,
                section_break,
                strip_link_syntax=strip_links,
                code_class_id=code_class_id,
                quote_class_id=quote_class_id,
                callout_class_map=callout_class_map,
                theme_mode=theme_mode,
                cover_page=cover_page,
                page_size=page_size,
                cover_metadata=cover_metadata,
            )
            filename = "export.html"
            mime_type = "text/html"
        elif fmt_str == "pdf":
            html_content = await self._renderer.render_html(
                nodes_data,
                resolve_node_link,
                layout,
                formatting,
                style,
                properties_data,
                density,
                numbering,
                measure,
                doctype,
                section_break,
                strip_link_syntax=strip_links,
                code_class_id=code_class_id,
                quote_class_id=quote_class_id,
                callout_class_map=callout_class_map,
                theme_mode=theme_mode,
                cover_page=cover_page,
                page_size=page_size,
                cover_metadata=cover_metadata,
            )
            try:
                pdf_bytes = await self._renderer.render_pdf(html_content, page_size)
                return pdf_bytes, "export.pdf", "application/pdf"
            except Exception as e:
                logger.warning(f"PDF generation failed: {e}; falling back to HTML")
                return html_content.encode("utf-8"), "export.html", "text/html"
        else:
            raise ValueError(f"Unsupported format: {format}")

        return content.encode("utf-8"), filename, mime_type

    async def generate_share_html(self, workspace_uuid: str, node_uuid: str) -> str:
        """Generate a static HTML export for a shared node."""
        content_bytes, _filename, _mime = await self.export_nodes(
            workspace_uuid=workspace_uuid,
            node_uuids=[node_uuid],
            format="html",
            include_children=True,
            layout="outline",
            formatting=True,
            properties="main",
            density="comfortable",
            numbering="none",
            measure="full",
            doctype="none",
            section_break=False,
            link_style="text",
            theme_mode="light",
            cover_page=False,
        )
        return content_bytes.decode("utf-8")

    async def write_share_html(
        self, share_uuid: str, workspace_uuid: str, node_uuid: str
    ) -> Path:
        """Generate and write static share HTML to disk."""
        html = await self.generate_share_html(workspace_uuid, node_uuid)
        path = self._renderer.static_share_path(share_uuid)
        path.write_text(html, encoding="utf-8")
        return path
