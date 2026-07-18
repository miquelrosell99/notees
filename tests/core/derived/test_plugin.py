"""Unit tests for the plugin-operation derived-state applier."""

from __future__ import annotations

import pytest

from app.core.derived import replay_operations
from tests.core.derived.conftest import make_operation

pytestmark = pytest.mark.unit


class TestPluginOpApplier:
    def test_plugin_op_creates_log_row(self) -> None:
        ops = [
            make_operation(
                "plugin.op",
                {
                    "pluginId": "plugin.calendar",
                    "opType": "event.create",
                    "nodeId": "event-node",
                    "data": {"start": "2026-07-18T10:00:00", "title": "Standup"},
                },
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT * FROM plugin_op_log WHERE plugin_id = ?", ("plugin.calendar",)
        ).fetchone()
        assert row is not None
        assert row["op_type"] == "event.create"
        assert row["node_id"] == "event-node"
        import json

        assert json.loads(row["data_json"]) == {
            "start": "2026-07-18T10:00:00",
            "title": "Standup",
        }
        conn.close()

    def test_plugin_op_is_idempotent_by_op_id(self) -> None:
        payload = {
            "pluginId": "plugin.calendar",
            "opType": "event.create",
            "data": {},
        }
        ops = [
            make_operation("plugin.op", payload, op_id="same-op-id"),
            make_operation("plugin.op", payload, op_id="same-op-id"),
        ]
        conn = replay_operations(ops)
        count = conn.execute(
            "SELECT COUNT(*) FROM plugin_op_log WHERE plugin_id = ?",
            ("plugin.calendar",),
        ).fetchone()[0]
        assert count == 1
        conn.close()
