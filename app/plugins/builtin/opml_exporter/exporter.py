"""OPML outline exporter adapter."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Any

from app.domain.stringify_ast import StringifyMode, StringifyOptions, parse_ast, stringify_ast
from app.plugins.core.ports import ExportContext, ExporterAdapter, ExportResult


def _node_title(name: str | None) -> str:
    """Extract a plain-text title from a node's name/content AST."""
    if not name:
        return "untitled"
    stripped = name.strip()
    try:
        ast = parse_ast(name)
    except (ValueError, TypeError):
        return stripped or "untitled"
    opts = StringifyOptions(mode=StringifyMode.TEXT_ONLY)
    title = stringify_ast(ast, opts).strip()
    if title:
        return title
    # Empty ASTs that were explicitly encoded as JSON return untitled; plain
    # text names are preserved.
    if stripped.startswith(("[", "{")):
        return "untitled"
    return stripped or "untitled"


def _build_opml_document(
    nodes_data: list[dict[str, Any]],
    title: str = "Notees export",
    show_uuid: bool = False,
) -> bytes:
    """Build an OPML 2.0 document from a Notees node tree.

    ``nodes_data`` is the list returned by ``ExportService`` ordered by tree
    traversal. Each item contains at least ``name``, ``uuid``, ``depth`` and
    ``is_page``.
    """
    root = ET.Element("opml", {"version": "2.0"})
    head = ET.SubElement(root, "head")
    ET.SubElement(head, "title").text = title

    body = ET.SubElement(root, "body")

    # Stack of (depth, element). We append root-level outlines to the body and
    # nest deeper outlines under their nearest shallower ancestor.
    stack: list[tuple[int, ET.Element]] = []

    for node in nodes_data:
        depth = int(node.get("depth", 0))
        text = _node_title(node.get("name"))
        attrs: dict[str, str] = {"text": text}
        if show_uuid:
            attrs["_note"] = f"uuid={node.get('uuid', '')}"

        outline = ET.Element("outline", attrs)

        while stack and stack[-1][0] >= depth:
            stack.pop()

        if stack:
            stack[-1][1].append(outline)
        else:
            body.append(outline)

        stack.append((depth, outline))

    ET.indent(root, space="  ")
    xml_bytes = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    return xml_bytes


class OpmlExporter(ExporterAdapter):
    """Export a Notees node tree as an OPML 2.0 outline."""

    format_id = "opml"
    label = "OPML"
    extension = "opml"
    mime_type = "text/x-opml+xml"

    async def export_nodes(self, context: ExportContext) -> ExportResult:
        options = context.options
        show_uuid = bool(options.get("show_uuid", False))

        nodes_data = context.nodes_data
        if not nodes_data:
            raise ValueError("No nodes found to export")

        title = "Notees export"
        if nodes_data:
            title = _node_title(nodes_data[0].get("name"))

        content = _build_opml_document(nodes_data, title=title, show_uuid=show_uuid)
        filename = f"{title.lower().replace(' ', '_')}.opml" if title != "untitled" else "export.opml"
        return ExportResult(
            content=content,
            filename=filename,
            mime_type=self.mime_type,
        )
