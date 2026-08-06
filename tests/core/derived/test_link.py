"""Unit tests for the link-click derived-state applier."""

from __future__ import annotations

import pytest

from app.core.derived import replay_operations
from tests.core.derived.conftest import make_operation

pytestmark = pytest.mark.unit


class TestLinkClickApplier:
    def test_link_click_creates_row(self) -> None:
        ops = [
            make_operation(
                "link.click",
                {
                    "sourceNodeId": "page-1",
                    "targetNodeId": "page-2",
                    "clickedAt": "2026-07-18T10:00:00",
                },
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT * FROM node_link WHERE source_id = ? AND target_id = ?",
            ("page-1", "page-2"),
        ).fetchone()
        assert row is not None
        assert row["click_count"] == 1
        assert row["last_navigated_at"] == "2026-07-18T10:00:00"
        conn.close()

    def test_link_click_increments_count(self) -> None:
        ops = [
            make_operation(
                "link.click",
                {"sourceNodeId": "page-1", "targetNodeId": "page-2"},
            ),
            make_operation(
                "link.click",
                {"sourceNodeId": "page-1", "targetNodeId": "page-2"},
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT click_count FROM node_link WHERE source_id = ? AND target_id = ?",
            ("page-1", "page-2"),
        ).fetchone()
        assert row["click_count"] == 2
        conn.close()
