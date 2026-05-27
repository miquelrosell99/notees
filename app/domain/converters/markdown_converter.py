"""Markdown node converter."""

from __future__ import annotations

from typing import Any

from ..stringify_ast import (
    StringifyMode,
    StringifyOptions,
    parse_ast,
    stringify_ast,
)


def _is_heading_node(node_data: dict[str, Any]) -> bool:
    """Return True if the node's first AST block has type 'heading'."""
    ast = node_data.get("_ast") or parse_ast(node_data.get("name", ""))
    return bool(ast and isinstance(ast, list) and ast[0].get("type") == "heading")


def _stringify_node(
    node_data: dict[str, Any],
    mode: StringifyMode,
    resolver,
    strip_link_syntax: bool = False,
    highlight_syntax: bool = True,
    link_target_brackets: bool = True,
) -> str:
    """Stringify a single node's AST to text."""
    ast = node_data.get("_ast") or parse_ast(node_data.get("name", ""))
    opts = StringifyOptions(
        mode=mode,
        resolve_node_link=resolver,
        strip_link_syntax=strip_link_syntax,
        highlight_syntax=highlight_syntax,
        link_target_brackets=link_target_brackets,
    )
    return stringify_ast(ast, opts)


def _node_is_code(node: dict[str, Any], code_class_id: int | None) -> bool:
    return code_class_id is not None and code_class_id in (node.get("class_ids") or [])


def _node_is_quote(node: dict[str, Any], quote_class_id: int | None) -> bool:
    return quote_class_id is not None and quote_class_id in (node.get("class_ids") or [])


def _node_callout_type(node: dict[str, Any], callout_class_map: dict[int, str]) -> str | None:
    class_ids = node.get("class_ids") or []
    for cid in class_ids:
        if cid in callout_class_map:
            return callout_class_map[cid]
    return None


class MarkdownConverter:
    """Convert nodes to Markdown format."""

    def convert(
        self,
        nodes: list[dict[str, Any]],
        resolver=None,
        layout: str = "outline",
        formatting: bool = True,
        properties_data: dict[str, list] | None = None,
        strip_link_syntax: bool = False,
        code_class_id: int | None = None,
        quote_class_id: int | None = None,
        callout_class_map: dict[int, str] | None = None,
        highlight_syntax: bool = True,
        link_target_brackets: bool = True,
    ) -> str:
        """Convert nodes to Markdown format."""
        if not nodes:
            return ""

        _props = properties_data or {}
        lines = []
        for node in nodes:
            text = _stringify_node(
                node, StringifyMode.PLAIN_MARKDOWN, resolver,
                strip_link_syntax=strip_link_syntax,
                highlight_syntax=highlight_syntax,
                link_target_brackets=link_target_brackets,
            )
            depth = node.get("depth", 0)
            is_page = node.get("is_page", False)
            is_code = _node_is_code(node, code_class_id)
            is_quote = _node_is_quote(node, quote_class_id)
            callout = _node_callout_type(node, callout_class_map or {})

            if formatting and node.get("color"):
                text = f"=={text}=="

            def _render_md_block(
                content: str,
                indent_prefix: str = "",
                _is_code: bool = is_code,
                _callout: str | None = callout,
                _is_quote: bool = is_quote,
            ) -> None:
                if _is_code:
                    lines.append(f"{indent_prefix}```")
                    for code_line in content.split("\n"):
                        lines.append(f"{indent_prefix}{code_line}")
                    lines.append(f"{indent_prefix}```")
                elif _callout:
                    lines.append(f"{indent_prefix}> [!{_callout.upper()}]")
                    for q_line in content.split("\n"):
                        lines.append(f"{indent_prefix}> {q_line}")
                elif _is_quote:
                    for q_line in content.split("\n"):
                        lines.append(f"{indent_prefix}> {q_line}")
                else:
                    lines.append(f"{indent_prefix}{content}")

            if is_page and layout == "flat":
                hashes = "#" * (depth + 1)
                lines.append(f"{hashes} {text}")
                props = _props.get(node.get("uuid", ""), [])
                for p in props:
                    if p.get("subtree"):
                        lines.append(f"{p['name']}::")
                        for sub_nd in p["subtree"]:
                            sub_text = _stringify_node(
                                sub_nd, StringifyMode.PLAIN_MARKDOWN, resolver,
                                strip_link_syntax=strip_link_syntax,
                                highlight_syntax=highlight_syntax,
                                link_target_brackets=link_target_brackets,
                            )
                            if formatting and sub_nd.get("color"):
                                sub_text = f"=={sub_text}=="
                            sub_depth = sub_nd.get("depth", 0)
                            sub_indent = "  " * (sub_depth + 1)
                            lines.append(f"{sub_indent}- {sub_text}")
                    elif p["values"]:
                        lines.append(f"{p['name']}:: {', '.join(p['values'])}")
                    else:
                        lines.append(f"{p['name']}::")
            elif layout == "flat":
                is_heading = _is_heading_node(node)
                if is_heading:
                    hashes = "#" * min(depth + 1, 6)
                    lines.append(f"{hashes} {text}")
                else:
                    _render_md_block(text)
                props = _props.get(node.get("uuid", ""), [])
                for p in props:
                    if p.get("subtree"):
                        lines.append(f"{p['name']}::")
                        for sub_nd in p["subtree"]:
                            sub_text = _stringify_node(
                                sub_nd, StringifyMode.PLAIN_MARKDOWN, resolver,
                                strip_link_syntax=strip_link_syntax,
                                highlight_syntax=highlight_syntax,
                                link_target_brackets=link_target_brackets,
                            )
                            if formatting and sub_nd.get("color"):
                                sub_text = f"=={sub_text}=="
                            sub_depth = sub_nd.get("depth", 0)
                            sub_indent = "  " * (sub_depth + 1)
                            lines.append(f"{sub_indent}- {sub_text}")
                    elif p["values"]:
                        lines.append(f"{p['name']}:: {', '.join(p['values'])}")
                    else:
                        lines.append(f"{p['name']}::")
            else:
                # outline
                is_heading = _is_heading_node(node)
                if is_heading:
                    hashes = "#" * min(depth + 1, 6)
                    lines.append(f"{hashes} {text}")
                else:
                    indent = "  " * depth
                    _render_md_block(text, indent + "- ")
                indent = "  " * depth
                props = _props.get(node.get("uuid", ""), [])
                for p in props:
                    if p.get("subtree"):
                        lines.append(f"{indent}  {p['name']}::")
                        for sub_nd in p["subtree"]:
                            sub_text = _stringify_node(
                                sub_nd, StringifyMode.PLAIN_MARKDOWN, resolver,
                                strip_link_syntax=strip_link_syntax,
                                highlight_syntax=highlight_syntax,
                                link_target_brackets=link_target_brackets,
                            )
                            if formatting and sub_nd.get("color"):
                                sub_text = f"=={sub_text}=="
                            sub_depth = sub_nd.get("depth", 0)
                            sub_indent = indent + "  " * (sub_depth + 2)
                            lines.append(f"{sub_indent}- {sub_text}")
                    elif p["values"]:
                        lines.append(f"{indent}  {p['name']}:: {', '.join(p['values'])}")
                    else:
                        lines.append(f"{indent}  {p['name']}::")

        return "\n".join(lines)
