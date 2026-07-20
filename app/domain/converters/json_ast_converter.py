"""JSON AST node converter."""

from __future__ import annotations

import json
from typing import Any

from ..stringify_ast import parse_ast


class JsonAstConverter:
    """Convert nodes to JSON AST format."""

    def convert(
        self,
        nodes: list[dict[str, Any]],
        resolver=None,
        layout: str = "outline",
        formatting: bool = True,
        properties_data: dict[str, list] | None = None,
        strip_link_syntax: bool = False,
        code_class_id: str | None = None,
        quote_class_id: str | None = None,
        callout_class_map: dict[str, str] | None = None,
    ) -> str:
        """Convert nodes to a JSON representation with AST and metadata.

        Each node is serialized with its UUID, name (raw AST), depth,
        is_page flag, color, class_ids, and optional properties.
        """
        if not nodes:
            return "[]"

        _props = properties_data or {}
        output_nodes = []
        for node in nodes:
            ast = node.get("_ast")
            if ast is None:
                ast = parse_ast(node.get("name", ""))

            entry: dict[str, Any] = {
                "uuid": node.get("uuid", ""),
                "ast": ast,
                "depth": node.get("depth", 0),
                "is_page": node.get("is_page", False),
            }
            if node.get("color"):
                entry["color"] = node["color"]
            if node.get("class_ids"):
                entry["class_ids"] = node["class_ids"]

            props = _props.get(node.get("uuid", ""), [])
            if props:
                entry["properties"] = props

            output_nodes.append(entry)

        return json.dumps(output_nodes, indent=2, ensure_ascii=False)
