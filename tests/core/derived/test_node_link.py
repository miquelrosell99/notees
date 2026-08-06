"""Unit tests for the node_link registry derivation."""

from __future__ import annotations

import pytest

from app.core.derived import replay_operations
from tests.core.derived.conftest import make_operation

pytestmark = pytest.mark.unit


def _content_with_link(target_id: str, link_id: str | None = None) -> list:
    link_id = link_id or target_id
    return [
        {
            "type": "paragraph",
            "children": [
                {"type": "node_link", "link_id": link_id, "ref_type": "node"}
            ],
        }
    ]


class TestNodeLinkDerivation:
    def test_node_create_extracts_link(self) -> None:
        ops = [
            make_operation(
                "node.create",
                {
                    "nodeId": "page-1",
                    "kind": "page",
                    "initialContent": _content_with_link("page-2", "page-2:link-1"),
                },
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT * FROM node_link WHERE id = ?", ("link-1",)
        ).fetchone()
        assert row is not None
        assert row["source_id"] == "page-1"
        assert row["target_id"] == "page-2"
        assert row["type"] == "node"
        conn.close()

    def test_node_update_replaces_stale_links(self) -> None:
        ops = [
            make_operation(
                "node.create",
                {
                    "nodeId": "page-1",
                    "kind": "page",
                    "initialContent": _content_with_link("page-2", "page-2:link-1"),
                },
            ),
            make_operation(
                "node.updateContent",
                {
                    "nodeId": "page-1",
                    "content": _content_with_link("page-3", "page-3:link-2"),
                },
            ),
        ]
        conn = replay_operations(ops)
        rows = conn.execute("SELECT id FROM node_link ORDER BY id").fetchall()
        assert [r["id"] for r in rows] == ["link-2"]
        conn.close()

    def test_legacy_bare_target_gets_deterministic_uuid(self) -> None:
        ops = [
            make_operation(
                "node.create",
                {
                    "nodeId": "page-1",
                    "kind": "page",
                    "initialContent": _content_with_link("page-2"),
                },
            ),
        ]
        conn = replay_operations(ops)
        rows = conn.execute(
            "SELECT * FROM node_link WHERE source_id = ? AND target_id = ?",
            ("page-1", "page-2"),
        ).fetchall()
        assert len(rows) == 1
        # Deterministic UUIDv5 for the legacy bare target.
        assert rows[0]["id"] == "0511617d-e4fc-540f-a447-25da344d92e2"
        conn.close()

    def test_node_delete_removes_links(self) -> None:
        ops = [
            make_operation(
                "node.create",
                {
                    "nodeId": "page-1",
                    "kind": "page",
                    "initialContent": _content_with_link("page-2", "page-2:link-1"),
                },
            ),
            make_operation("node.delete", {"nodeId": "page-1"}),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT * FROM node_link WHERE id = ?", ("link-1",)
        ).fetchone()
        assert row is None
        conn.close()



