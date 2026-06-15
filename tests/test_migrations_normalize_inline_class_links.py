"""Tests for normalize_inline_class_links migration."""

from __future__ import annotations

from app.db.migrations.normalize_inline_class_links import _resolve_numeric_ids, _walk


def _ast_with_inline_class(link_id: str) -> list:
    return [
        {
            "type": "paragraph",
            "children": [
                {"type": "node_link", "link_id": link_id, "ref_type": "class"}
            ],
        }
    ]


def test_walk_lowercase_uuid_unchanged() -> None:
    link_id = "67ceae54-412e-4852-bafc-1f50e0fa3070:ba786dd2-b91b-463c-a051-cabdf238ab5f"
    ast = _ast_with_inline_class(link_id)
    new_ast, changed = _walk(ast, set())
    assert not changed
    assert new_ast == ast


def test_walk_uppercase_uuid_normalized() -> None:
    ast = _ast_with_inline_class(
        "67CEAE54-412E-4852-BAFC-1F50E0FA3070:ba786dd2-b91b-463c-a051-cabdf238ab5f"
    )
    new_ast, changed = _walk(ast, set())
    assert changed
    link_id = new_ast[0]["children"][0]["link_id"]
    assert link_id == "67ceae54-412e-4852-bafc-1f50e0fa3070:ba786dd2-b91b-463c-a051-cabdf238ab5f"


def test_walk_numeric_id_collected() -> None:
    ast = _ast_with_inline_class("12345:ba786dd2-b91b-463c-a051-cabdf238ab5f")
    numeric_ids: set[int] = set()
    new_ast, changed = _walk(ast, numeric_ids)
    assert changed
    assert numeric_ids == {12345}
    # Placeholder inserted.
    assert new_ast[0]["children"][0].get("__numeric_placeholder__") is True


def test_walk_empty_identifier_becomes_broken() -> None:
    ast = _ast_with_inline_class(":ba786dd2-b91b-463c-a051-cabdf238ab5f")
    new_ast, changed = _walk(ast, set())
    assert changed
    assert new_ast[0]["children"][0]["type"] == "broken_link"


def test_resolve_numeric_ids_replaces_with_uuid() -> None:
    ast = [
        {
            "type": "paragraph",
            "children": [
                {
                    "__numeric_placeholder__": True,
                    "node": {
                        "type": "node_link",
                        "link_id": "12345:ba786dd2-b91b-463c-a051-cabdf238ab5f",
                        "ref_type": "class",
                    },
                }
            ],
        }
    ]
    id_to_uuid = {12345: "67ceae54-412e-4852-bafc-1f50e0fa3070"}
    new_ast, changed = _resolve_numeric_ids(ast, id_to_uuid)
    assert changed
    link_id = new_ast[0]["children"][0]["link_id"]
    assert link_id == "67ceae54-412e-4852-bafc-1f50e0fa3070:ba786dd2-b91b-463c-a051-cabdf238ab5f"


def test_resolve_numeric_ids_unknown_becomes_broken() -> None:
    ast = [
        {
            "type": "paragraph",
            "children": [
                {
                    "__numeric_placeholder__": True,
                    "node": {
                        "type": "node_link",
                        "link_id": "99999:ba786dd2-b91b-463c-a051-cabdf238ab5f",
                        "ref_type": "class",
                    },
                }
            ],
        }
    ]
    new_ast, changed = _resolve_numeric_ids(ast, {})
    assert changed
    assert new_ast[0]["children"][0]["type"] == "broken_link"


def test_walk_recurses_into_children() -> None:
    ast = [
        {
            "type": "strong",
            "children": [
                {
                    "type": "node_link",
                    "link_id": "67CEAE54-412E-4852-BAFC-1F50E0FA3070",
                    "ref_type": "class",
                }
            ],
        }
    ]
    new_ast, changed = _walk(ast, set())
    assert changed
    assert (
        new_ast[0]["children"][0]["link_id"]
        == "67ceae54-412e-4852-bafc-1f50e0fa3070"
    )
