"""OPML export converter for Notees node trees."""

from __future__ import annotations

from xml.etree.ElementTree import Element, SubElement, tostring

from app.domain.stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, stringify_ast
from app.features.nodes.node_service import NodeService


def _node_text(name: str) -> str:
    """Return the plain-text title of a node from its serialized AST name."""
    try:
        ast = parse_ast(name, ParseMode.JSON)
        return stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
    except Exception:
        return name


async def _build_outline(node_id: int, node_service: NodeService) -> Element:
    """Recursively build an OPML outline element for a node."""
    node = await node_service.get_node_by_id(node_id)
    if node is None:
        raise ValueError(f"Node not found: {node_id}")

    outline = Element("outline", {"text": _node_text(node.name)})
    children = await node_service.get_node_children(node_id)
    for child in children:
        if child.id is not None:
            outline.append(await _build_outline(child.id, node_service))
    return outline


async def generate_opml(node_uuid: str, node_service: NodeService) -> str:
    """Generate an OPML string for the node tree rooted at ``node_uuid``."""
    node = await node_service.get_node_by_uuid(node_uuid)
    if node is None or node.id is None:
        raise ValueError(f"Node not found: {node_uuid}")

    root = Element("opml", {"version": "2.0"})
    head = SubElement(root, "head")
    title = SubElement(head, "title")
    title.text = _node_text(node.name)

    body = SubElement(root, "body")
    body.append(await _build_outline(node.id, node_service))

    return '<?xml version="1.0" encoding="UTF-8"?>\n' + tostring(root, encoding="unicode")
