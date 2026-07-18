"""Unit tests for the task completion/recurrence derived-state applier."""

from __future__ import annotations

import pytest

from app.core.derived import replay_operations
from tests.core.derived.conftest import make_operation

pytestmark = pytest.mark.unit


class TestTaskCompletion:
    def test_record_completion_creates_row(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "task-1", "kind": "page", "index": 0}),
            make_operation(
                "task.recordCompletion",
                {
                    "completionId": "comp-1",
                    "nodeId": "task-1",
                    "completedAt": "2026-07-18T10:00:00",
                },
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT * FROM task_completion WHERE id = ?", ("comp-1",)
        ).fetchone()
        assert row is not None
        assert row["node_id"] == "task-1"
        assert row["completed_at"] == "2026-07-18T10:00:00"
        assert row["actor_id"] == "actor-1"
        conn.close()

    def test_record_completion_is_idempotent(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "task-1", "kind": "page", "index": 0}),
            make_operation(
                "task.recordCompletion",
                {"completionId": "comp-1", "nodeId": "task-1"},
            ),
            make_operation(
                "task.recordCompletion",
                {"completionId": "comp-1", "nodeId": "task-1"},
            ),
        ]
        conn = replay_operations(ops)
        count = conn.execute(
            "SELECT COUNT(*) FROM task_completion WHERE id = ?", ("comp-1",)
        ).fetchone()[0]
        assert count == 1
        conn.close()

    def test_delete_completion_removes_row(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "task-1", "kind": "page", "index": 0}),
            make_operation(
                "task.recordCompletion",
                {"completionId": "comp-1", "nodeId": "task-1"},
            ),
            make_operation("task.deleteCompletion", {"completionId": "comp-1"}),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT 1 FROM task_completion WHERE id = ?", ("comp-1",)
        ).fetchone()
        assert row is None
        conn.close()


class TestTaskRecurrence:
    def test_set_recurrence_creates_row(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "task-1", "kind": "page", "index": 0}),
            make_operation(
                "task.setRecurrence",
                {
                    "nodeId": "task-1",
                    "rule": {"interval": "daily", "frequency": 1},
                },
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT * FROM task_recurrence WHERE node_id = ?", ("task-1",)
        ).fetchone()
        assert row is not None
        import json

        assert json.loads(row["rule_json"]) == {"interval": "daily", "frequency": 1}
        conn.close()

    def test_set_recurrence_overwrites_existing_rule(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "task-1", "kind": "page", "index": 0}),
            make_operation(
                "task.setRecurrence",
                {"nodeId": "task-1", "rule": {"interval": "daily"}},
            ),
            make_operation(
                "task.setRecurrence",
                {"nodeId": "task-1", "rule": {"interval": "weekly"}},
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT rule_json FROM task_recurrence WHERE node_id = ?", ("task-1",)
        ).fetchone()
        import json

        assert json.loads(row["rule_json"]) == {"interval": "weekly"}
        conn.close()

    def test_delete_recurrence_removes_row(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "task-1", "kind": "page", "index": 0}),
            make_operation(
                "task.setRecurrence",
                {"nodeId": "task-1", "rule": {"interval": "daily"}},
            ),
            make_operation("task.deleteRecurrence", {"nodeId": "task-1"}),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT 1 FROM task_recurrence WHERE node_id = ?", ("task-1",)
        ).fetchone()
        assert row is None
        conn.close()
