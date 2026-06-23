"""Unit tests for node response helper functions."""

import json

import pytest

from app.domain.entities import Node
from app.domain.stringify_ast import ParseMode, parse_ast, serialize_ast
from app.features.nodes.router.helpers import _name_text, _node_to_response


def _ast(text: str) -> str:
    """Wrap plain text in a simple paragraph AST and serialize to JSON."""
    return serialize_ast(parse_ast(text, ParseMode.PLAIN))


@pytest.mark.unit
class TestNameText:
    def test_empty_name_returns_empty(self):
        assert _name_text("") == ""
        assert _name_text(None) == ""

    def test_plain_text_passes_through(self):
        assert _name_text("Plain title") == "Plain title"

    def test_ast_json_extracts_text(self):
        raw = _ast("Hello world")
        assert _name_text(raw) == "Hello world"

    def test_ast_with_formatting_extracts_text(self):
        raw = serialize_ast(parse_ast("**bold** and *italic*", ParseMode.MARKDOWN))
        assert _name_text(raw) == "bold and italic"

    def test_respects_max_len(self):
        assert _name_text("Hello world", max_len=5) == "Hello"

    def test_no_truncation_when_max_len_none(self):
        long_text = "a" * 1000
        raw = _ast(long_text)
        assert _name_text(raw, max_len=None) == long_text

    def test_invalid_json_returns_raw_name(self):
        assert _name_text("not json") == "not json"


@pytest.mark.unit
class TestNodeToResponseDisplayName:
    def test_display_name_is_plain_text_not_raw_ast(self):
        node = Node(
            id=1,
            uuid="node-uuid",
            name=_ast("My page title"),
        )

        response = _node_to_response(node)

        assert response.display_name == "My page title"
        assert response.name == _ast("My page title")

    def test_display_name_for_plain_name(self):
        node = Node(
            id=1,
            uuid="node-uuid",
            name="Legacy title",
        )

        response = _node_to_response(node)

        assert response.display_name == "Legacy title"

    def test_display_name_for_empty_name(self):
        node = Node(
            id=1,
            uuid="node-uuid",
            name="",
        )

        response = _node_to_response(node)

        assert response.display_name == ""

    def test_display_name_extracts_whiteboard_text(self):
        ast = [
            {
                "type": "whiteboard",
                "data": {
                    "elements": [
                        {"type": "text", "text": "Sticky"},
                        {"type": "shape", "text": "Note"},
                    ]
                },
            }
        ]
        node = Node(
            id=1,
            uuid="node-uuid",
            name=json.dumps(ast),
        )

        response = _node_to_response(node)

        assert response.display_name == "Sticky Note"

    def test_display_name_for_node_link_without_label(self):
        ast = [
            {
                "type": "paragraph",
                "children": [
                    {"type": "node_link", "link_id": "target-uuid:link-uuid"}
                ],
            }
        ]
        node = Node(
            id=1,
            uuid="node-uuid",
            name=json.dumps(ast),
        )

        response = _node_to_response(node)

        assert response.display_name == "…"

    def test_display_name_for_node_link_with_label(self):
        ast = [
            {
                "type": "paragraph",
                "children": [
                    {
                        "type": "node_link",
                        "link_id": "target-uuid:link-uuid",
                        "label": "Linked page",
                    }
                ],
            }
        ]
        node = Node(
            id=1,
            uuid="node-uuid",
            name=json.dumps(ast),
        )

        response = _node_to_response(node)

        assert response.display_name == "Linked page"
