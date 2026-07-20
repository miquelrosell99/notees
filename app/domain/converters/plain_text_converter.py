"""Plain text node converter."""

from __future__ import annotations

from typing import Any

from ..stringify_ast import (
    StringifyMode,
    StringifyOptions,
    parse_ast,
    stringify_ast,
)


def _stringify_node(
    node_data: dict[str, Any],
    mode: StringifyMode,
    resolver,
) -> str:
    """Stringify a single node's AST to text."""
    ast = node_data.get("_ast") or parse_ast(node_data.get("name", ""))
    opts = StringifyOptions(mode=mode, resolve_node_link=resolver)
    return stringify_ast(ast, opts)


class PlainTextConverter:
    """Convert nodes to plain text format."""

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
        """Convert nodes to plain text format."""
        if not nodes:
            return ""

        _props = properties_data or {}
        lines = []
        for node in nodes:
            text = _stringify_node(node, StringifyMode.TEXT_ONLY, resolver)
            depth = node.get("depth", 0)
            is_page = node.get("is_page", False)

            if is_page and layout == "flat":
                lines.append(f"{'  ' * depth}{text}")
                props = _props.get(node.get("uuid", ""), [])
                for p in props:
                    if p.get("subtree"):
                        lines.append(f"{'  ' * (depth + 1)}{p['name']}:")
                        for sub_nd in p["subtree"]:
                            sub_text = _stringify_node(sub_nd, StringifyMode.TEXT_ONLY, resolver)
                            sub_depth = sub_nd.get("depth", 0)
                            lines.append(f"{'  ' * (depth + sub_depth + 2)}- {sub_text}")
                    elif p["values"]:
                        lines.append(f"{'  ' * (depth + 1)}{p['name']}: {', '.join(p['values'])}")
                    else:
                        lines.append(f"{'  ' * (depth + 1)}{p['name']}:")
            elif layout == "flat":
                lines.append(text)
                props = _props.get(node.get("uuid", ""), [])
                for p in props:
                    if p.get("subtree"):
                        lines.append(f"  {p['name']}:")
                        for sub_nd in p["subtree"]:
                            sub_text = _stringify_node(sub_nd, StringifyMode.TEXT_ONLY, resolver)
                            sub_depth = sub_nd.get("depth", 0)
                            lines.append(f"{'  ' * (sub_depth + 2)}- {sub_text}")
                    elif p["values"]:
                        lines.append(f"  {p['name']}: {', '.join(p['values'])}")
                    else:
                        lines.append(f"  {p['name']}:")
            else:
                # outline
                indent = "  " * depth
                lines.append(f"{indent}- {text}")
                props = _props.get(node.get("uuid", ""), [])
                for p in props:
                    if p.get("subtree"):
                        lines.append(f"{indent}  {p['name']}:")
                        for sub_nd in p["subtree"]:
                            sub_text = _stringify_node(sub_nd, StringifyMode.TEXT_ONLY, resolver)
                            sub_depth = sub_nd.get("depth", 0)
                            lines.append(f"{indent}  {'  ' * (sub_depth + 1)}- {sub_text}")
                    elif p["values"]:
                        lines.append(f"{indent}  {p['name']}: {', '.join(p['values'])}")
                    else:
                        lines.append(f"{indent}  {p['name']}:")

        return "\n".join(lines)
