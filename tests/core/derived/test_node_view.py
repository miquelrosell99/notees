"""Unit tests for NodeView derived-state appliers."""

from __future__ import annotations

import json

import pytest

from app.core.derived import replay_operations
from tests.core.derived.conftest import make_operation

pytestmark = pytest.mark.unit


class TestNodeViewApplier:
    def test_create_node_view(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation(
                "nodeView.create",
                {
                    "viewId": "v-1",
                    "nodeId": "n-1",
                    "name": "Child Pages",
                    "viewType": "child_pages",
                    "orderIndex": 0,
                    "isDefault": True,
                    "queryAst": {"type": "query", "version": "1.0"},
                },
                physical=2,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT id, node_id, name, view_type, order_index, is_default, query_ast FROM node_view WHERE id = ?",
            ("v-1",),
        ).fetchone()
        assert row is not None
        assert row["node_id"] == "n-1"
        assert row["name"] == "Child Pages"
        assert row["view_type"] == "child_pages"
        assert row["order_index"] == 0
        assert row["is_default"] == 1
        assert json.loads(row["query_ast"]) == {"type": "query", "version": "1.0"}
        conn.close()

    def test_update_node_view(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation(
                "nodeView.create",
                {
                    "viewId": "v-1",
                    "nodeId": "n-1",
                    "name": "Old Name",
                    "viewType": "child_pages",
                },
                physical=2,
            ),
            make_operation(
                "nodeView.update",
                {"viewId": "v-1", "name": "New Name", "orderIndex": 3, "isDefault": True},
                physical=3,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT name, order_index, is_default FROM node_view WHERE id = ?",
            ("v-1",),
        ).fetchone()
        assert row["name"] == "New Name"
        assert row["order_index"] == 3
        assert row["is_default"] == 1
        conn.close()

    def test_update_clears_field_with_null(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation(
                "nodeView.create",
                {
                    "viewId": "v-1",
                    "nodeId": "n-1",
                    "name": "Name",
                    "viewType": "child_pages",
                    "viewMode": "list",
                },
                physical=2,
            ),
            make_operation(
                "nodeView.update",
                {"viewId": "v-1", "viewMode": None},
                physical=3,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT view_mode FROM node_view WHERE id = ?",
            ("v-1",),
        ).fetchone()
        assert row["view_mode"] is None
        conn.close()

    def test_delete_node_view(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation(
                "nodeView.create",
                {"viewId": "v-1", "nodeId": "n-1", "name": "Name", "viewType": "child_pages"},
                physical=2,
            ),
            make_operation("nodeView.delete", {"viewId": "v-1"}, physical=3),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT COUNT(*) AS count FROM node_view WHERE id = ?",
            ("v-1",),
        ).fetchone()
        assert row["count"] == 0
        conn.close()

    def test_reorder_node_views(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation(
                "nodeView.create",
                {"viewId": "v-1", "nodeId": "n-1", "name": "A", "viewType": "child_pages", "orderIndex": 0},
                physical=2,
            ),
            make_operation(
                "nodeView.create",
                {"viewId": "v-2", "nodeId": "n-1", "name": "B", "viewType": "child_pages", "orderIndex": 1},
                physical=3,
            ),
            make_operation(
                "nodeView.reorder",
                {"nodeId": "n-1", "viewType": "child_pages", "orderedViewIds": ["v-2", "v-1"]},
                physical=4,
            ),
        ]
        conn = replay_operations(ops)
        rows = conn.execute(
            "SELECT id, order_index FROM node_view WHERE node_id = ? ORDER BY order_index",
            ("n-1",),
        ).fetchall()
        assert [(row["id"], row["order_index"]) for row in rows] == [("v-2", 0), ("v-1", 1)]
        conn.close()

    def test_ensure_default_views_is_idempotent(self) -> None:
        """Creating the same view twice via create replays to a single row."""
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation(
                "nodeView.create",
                {"viewId": "v-1", "nodeId": "n-1", "name": "Child Pages", "viewType": "child_pages"},
                physical=2,
            ),
            make_operation(
                "nodeView.create",
                {"viewId": "v-1", "nodeId": "n-1", "name": "Child Pages", "viewType": "child_pages"},
                physical=3,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT COUNT(*) AS count FROM node_view WHERE id = ?",
            ("v-1",),
        ).fetchone()
        assert row["count"] == 1
        conn.close()

    def test_cleanup_on_node_delete(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": 0}),
            make_operation(
                "nodeView.create",
                {"viewId": "v-1", "nodeId": "n-1", "name": "Name", "viewType": "child_pages"},
                physical=2,
            ),
            make_operation("node.delete", {"nodeId": "n-1"}, physical=3),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT COUNT(*) AS count FROM node_view WHERE node_id = ?",
            ("n-1",),
        ).fetchone()
        assert row["count"] == 0
        conn.close()
