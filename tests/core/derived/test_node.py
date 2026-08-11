"""Unit tests for node-level derived-state appliers."""

from __future__ import annotations

import json

import pytest

from app.core.derived import replay_operations
from tests.core.derived.conftest import make_operation

pytestmark = pytest.mark.unit


class TestNodeUpdateContentApplier:
    def test_crdt_update_list_sets_content(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation(
                "node.updateContent",
                {"nodeId": "n-1", "crdtUpdate": [{"type": "text", "text": "hello"}]},
                physical=2,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute("SELECT content FROM node WHERE id = ?", ("n-1",)).fetchone()
        assert json.loads(row["content"]) == [{"type": "text", "text": "hello"}]
        conn.close()

    def test_content_payload_sets_ast(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation(
                "node.updateContent",
                {
                    "nodeId": "n-1",
                    "content": [
                        {"type": "paragraph", "children": [{"type": "text", "text": "t"}]},
                        {"type": "whiteboard", "data": {"shapes": []}},
                    ],
                },
                physical=2,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute("SELECT content FROM node WHERE id = ?", ("n-1",)).fetchone()
        assert json.loads(row["content"])[1]["type"] == "whiteboard"
        conn.close()

    def test_text_update_stores_crdt_state_and_placeholder_content(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation(
                "node.updateContent",
                {"nodeId": "n-1", "textUpdate": [1, 2, 3]},
                physical=2,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute("SELECT content FROM node WHERE id = ?", ("n-1",)).fetchone()
        assert json.loads(row["content"]) == [{"type": "text", "text": ""}]
        state = conn.execute(
            "SELECT text_state FROM crdt_state WHERE node_id = ?", ("n-1",)
        ).fetchone()
        assert state["text_state"] == bytes([1, 2, 3])
        conn.close()

    def test_tree_update_stores_tree_state_without_touching_content(self) -> None:
        ops = [
            make_operation(
                "node.create",
                {"nodeId": "n-1", "kind": "page", "index": 0, "initialContent": [{"type": "text", "text": "title"}]},
            ),
            make_operation(
                "node.updateContent",
                {"nodeId": "n-1", "treeUpdate": [4, 5, 6]},
                physical=2,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute("SELECT content FROM node WHERE id = ?", ("n-1",)).fetchone()
        assert json.loads(row["content"]) == [{"type": "text", "text": "title"}]
        state = conn.execute(
            "SELECT tree_state FROM crdt_state WHERE node_id = ?", ("n-1",)
        ).fetchone()
        assert state["tree_state"] == bytes([4, 5, 6])
        conn.close()

    def test_older_content_update_is_ignored(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation(
                "node.updateContent",
                {"nodeId": "n-1", "content": [{"type": "text", "text": "newer"}]},
                physical=3,
            ),
            make_operation(
                "node.updateContent",
                {"nodeId": "n-1", "content": [{"type": "text", "text": "older"}]},
                physical=2,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute("SELECT content FROM node WHERE id = ?", ("n-1",)).fetchone()
        assert json.loads(row["content"]) == [{"type": "text", "text": "newer"}]
        conn.close()

    def test_content_dict_is_wrapped(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation(
                "node.updateContent",
                {"nodeId": "n-1", "content": {"type": "text", "text": "hi"}},
                physical=2,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute("SELECT content FROM node WHERE id = ?", ("n-1",)).fetchone()
        assert json.loads(row["content"]) == [{"type": "text", "text": "hi"}]
        conn.close()


class TestNodeArchiveRestoreApplier:
    def test_archive_sets_active_to_zero(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation("node.archive", {"nodeId": "n-1"}, physical=2),
        ]
        conn = replay_operations(ops)
        row = conn.execute("SELECT active FROM node WHERE id = ?", ("n-1",)).fetchone()
        assert row["active"] == 0
        conn.close()

    def test_restore_sets_active_back_to_one(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation("node.archive", {"nodeId": "n-1"}, physical=2),
            make_operation("node.restore", {"nodeId": "n-1"}, physical=3),
        ]
        conn = replay_operations(ops)
        row = conn.execute("SELECT active FROM node WHERE id = ?", ("n-1",)).fetchone()
        assert row["active"] == 1
        conn.close()


class TestNodeIconColorApplier:
    def test_create_persists_icon_and_color(self) -> None:
        ops = [
            make_operation(
                "node.create",
                {
                    "nodeId": "n-1",
                    "kind": "page",
                    "index": 0,
                    "icon": "mdiStar",
                    "color": "#ff0000",
                },
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT icon, color FROM node WHERE id = ?", ("n-1",)
        ).fetchone()
        assert row["icon"] == "mdiStar"
        assert row["color"] == "#ff0000"
        conn.close()

    def test_update_icon_and_color(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation(
                "node.updateIcon",
                {"nodeId": "n-1", "icon": "mdiHeart"},
                physical=2,
            ),
            make_operation(
                "node.updateColor",
                {"nodeId": "n-1", "color": "#00ff00"},
                physical=3,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT icon, color FROM node WHERE id = ?", ("n-1",)
        ).fetchone()
        assert row["icon"] == "mdiHeart"
        assert row["color"] == "#00ff00"
        conn.close()

    def test_update_icon_and_color_can_clear(self) -> None:
        ops = [
            make_operation(
                "node.create",
                {
                    "nodeId": "n-1",
                    "kind": "page",
                    "index": 0,
                    "icon": "mdiStar",
                    "color": "#ff0000",
                },
            ),
            make_operation(
                "node.updateIcon",
                {"nodeId": "n-1", "icon": None},
                physical=2,
            ),
            make_operation(
                "node.updateColor",
                {"nodeId": "n-1", "color": None},
                physical=3,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT icon, color FROM node WHERE id = ?", ("n-1",)
        ).fetchone()
        assert row["icon"] is None
        assert row["color"] is None
        conn.close()
