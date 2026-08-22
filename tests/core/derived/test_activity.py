"""Unit tests for the activity-log derived-state applier."""

from __future__ import annotations

import pytest

from app.core.derived import replay_operations
from tests.core.derived.conftest import make_operation

pytestmark = pytest.mark.unit


class TestActivityApplier:
    def test_activity_record_creates_row(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "page-1", "kind": "page", "index": 0}),
            make_operation(
                "activity.record",
                {
                    "activityId": "act-1",
                    "nodeId": "page-1",
                    "action": "property_changed",
                    "targetNodeId": "target-1",
                    "details": {"property": "status", "old": "todo", "new": "done"},
                },
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute("SELECT * FROM activity_log WHERE id = ?", ("act-1",)).fetchone()
        assert row is not None
        assert row["node_id"] == "page-1"
        assert row["action"] == "property_changed"
        assert row["target_node_id"] == "target-1"
        import json

        assert json.loads(row["details"]) == {
            "property": "status",
            "old": "todo",
            "new": "done",
        }
        assert row["actor_id"] == "actor-1"
        assert row["hlc_physical"] == 1
        assert row["hlc_logical"] == 0
        conn.close()

    def test_activity_record_is_idempotent(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "page-1", "kind": "page", "index": 0}),
            make_operation(
                "activity.record",
                {"activityId": "act-1", "nodeId": "page-1", "action": "created"},
            ),
            make_operation(
                "activity.record",
                {"activityId": "act-1", "nodeId": "page-1", "action": "created"},
            ),
        ]
        conn = replay_operations(ops)
        count = conn.execute(
            "SELECT COUNT(*) FROM activity_log WHERE id = ?", ("act-1",)
        ).fetchone()[0]
        assert count == 1
        conn.close()

    def test_activity_delete_removes_row(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "page-1", "kind": "page", "index": 0}),
            make_operation(
                "activity.record",
                {"activityId": "act-1", "nodeId": "page-1", "action": "created"},
            ),
            make_operation(
                "activity.delete",
                {"activityId": "act-1", "nodeId": "page-1"},
            ),
        ]
        conn = replay_operations(ops)
        count = conn.execute(
            "SELECT COUNT(*) FROM activity_log WHERE id = ?", ("act-1",)
        ).fetchone()[0]
        assert count == 0
        conn.close()

    def test_activity_delete_is_scoped_to_node(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "page-1", "kind": "page", "index": 0}),
            make_operation(
                "activity.record",
                {"activityId": "act-1", "nodeId": "page-1", "action": "created"},
            ),
            make_operation(
                "activity.delete",
                {"activityId": "act-1", "nodeId": "page-2"},
            ),
        ]
        conn = replay_operations(ops)
        count = conn.execute(
            "SELECT COUNT(*) FROM activity_log WHERE id = ?", ("act-1",)
        ).fetchone()[0]
        assert count == 1
        conn.close()
