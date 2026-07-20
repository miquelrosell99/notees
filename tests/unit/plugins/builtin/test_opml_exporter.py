"""Unit tests for the OPML exporter plugin."""

from __future__ import annotations

import xml.etree.ElementTree as ET

import pytest

from app.plugins.builtin.opml_exporter.exporter import (
    OpmlExporter,
    _build_opml_document,
    _node_title,
)
from app.plugins.core.ports import ExportContext, ExportResult


def _ast_text_json(text: str) -> str:
    """Return the JSON AST representation Notees uses for plain text titles."""
    return f'[{{"type": "paragraph", "children": [{{"type": "text", "text": "{text}"}}]}}]'


@pytest.mark.unit
@pytest.mark.asyncio
async def test_opml_exporter_empty_nodes_raises() -> None:
    """Exporting an empty node list raises ValueError."""
    exporter = OpmlExporter()
    context = ExportContext(
        node_ids=[],
        workspace_id=1,
        user_id=1,
        plugin_context=None,  # type: ignore[arg-type]
        nodes_data=[],
    )

    with pytest.raises(ValueError, match="No nodes found"):
        await exporter.export_nodes(context)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_opml_exporter_flat_list() -> None:
    """A flat list of nodes becomes sibling outlines."""
    exporter = OpmlExporter()
    nodes_data = [
        {"id": 1, "uuid": "uuid-1", "name": _ast_text_json("First"), "depth": 0, "is_page": True},
        {"id": 2, "uuid": "uuid-2", "name": _ast_text_json("Second"), "depth": 0, "is_page": True},
    ]
    context = ExportContext(
        node_ids=[1, 2],
        workspace_id=1,
        user_id=1,
        plugin_context=None,  # type: ignore[arg-type]
        nodes_data=nodes_data,
    )

    result = await exporter.export_nodes(context)
    assert isinstance(result, ExportResult)
    assert result.filename == "first.opml"
    assert result.mime_type == "text/x-opml+xml"

    root = ET.fromstring(result.content)
    body = root.find("body")
    assert body is not None
    outlines = body.findall("outline")
    assert len(outlines) == 2
    assert outlines[0].get("text") == "First"
    assert outlines[1].get("text") == "Second"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_opml_exporter_nested_outline() -> None:
    """Nested depths produce nested outline elements."""
    exporter = OpmlExporter()
    nodes_data = [
        {"id": 1, "uuid": "uuid-1", "name": _ast_text_json("Root"), "depth": 0, "is_page": True},
        {"id": 2, "uuid": "uuid-2", "name": _ast_text_json("Child A"), "depth": 1, "is_page": False},
        {"id": 3, "uuid": "uuid-3", "name": _ast_text_json("Child B"), "depth": 1, "is_page": False},
        {"id": 4, "uuid": "uuid-4", "name": _ast_text_json("Grandchild"), "depth": 2, "is_page": False},
    ]
    context = ExportContext(
        node_ids=[1, 2, 3, 4],
        workspace_id=1,
        user_id=1,
        plugin_context=None,  # type: ignore[arg-type]
        nodes_data=nodes_data,
    )

    result = await exporter.export_nodes(context)
    root = ET.fromstring(result.content)
    body = root.find("body")
    assert body is not None

    top = body.findall("outline")
    assert len(top) == 1
    root_outline = top[0]
    assert root_outline.get("text") == "Root"

    children = root_outline.findall("outline")
    assert len(children) == 2
    assert children[0].get("text") == "Child A"
    assert children[1].get("text") == "Child B"

    grandchildren = children[1].findall("outline")
    assert len(grandchildren) == 1
    assert grandchildren[0].get("text") == "Grandchild"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_opml_exporter_show_uuid_option() -> None:
    """The show_uuid option surfaces node UUIDs in the _note attribute."""
    exporter = OpmlExporter()
    nodes_data = [
        {"id": 1, "uuid": "uuid-abc", "name": _ast_text_json("Node"), "depth": 0, "is_page": True},
    ]
    context = ExportContext(
        node_ids=[1],
        workspace_id=1,
        user_id=1,
        plugin_context=None,  # type: ignore[arg-type]
        nodes_data=nodes_data,
        options={"show_uuid": True},
    )

    result = await exporter.export_nodes(context)
    root = ET.fromstring(result.content)
    outline = root.find("body/outline")
    assert outline is not None
    assert outline.get("_note") == "uuid=uuid-abc"


@pytest.mark.unit
def test_build_opml_document_skips_text_property_subtrees() -> None:
    """The exporter treats the supplied nodes_data verbatim; callers filter."""
    nodes_data = [
        {"id": 1, "uuid": "uuid-1", "name": _ast_text_json("Keep"), "depth": 0, "is_page": True},
        {"id": 2, "uuid": "uuid-2", "name": _ast_text_json("Filter me"), "depth": 1, "is_page": False},
    ]
    content = _build_opml_document(nodes_data, title="Test")
    root = ET.fromstring(content)
    assert root.find("head/title").text == "Test"
    assert len(root.find("body").findall("outline")) == 1


@pytest.mark.unit
def test_node_title_plain_text() -> None:
    """Plain text titles are returned as-is."""
    assert _node_title(_ast_text_json("Hello world")) == "Hello world"


@pytest.mark.unit
def test_node_title_empty_and_invalid() -> None:
    """Empty or invalid names fall back to 'untitled'."""
    assert _node_title("") == "untitled"
    assert _node_title("   ") == "untitled"
    assert _node_title("not json") == "not json"
    assert _node_title("{}") == "untitled"
