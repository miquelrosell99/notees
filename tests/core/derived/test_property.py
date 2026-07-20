"""Unit tests for property-schema and class-property-edge derived-state appliers."""

from __future__ import annotations

import json

import pytest

from app.core.derived import replay_operations
from tests.core.derived.conftest import make_operation

pytestmark = pytest.mark.unit


class TestPropertySchemaApplier:
    def test_create_property_schema(self) -> None:
        ops = [
            make_operation(
                "propertySchema.create",
                {
                    "schemaId": "s-1",
                    "name": "Priority",
                    "icon": "mdi-star",
                    "type": "selection",
                    "multi": False,
                    "scope": "global",
                    "required": True,
                    "readonly": False,
                    "hideWhenEmpty": False,
                    "options": [
                        {"uuid": "opt-1", "name": "High", "sequence": 0},
                    ],
                },
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT name, icon, type, multi, required, options FROM property_schema WHERE id = ?",
            ("s-1",),
        ).fetchone()
        assert row is not None
        assert row["name"] == "Priority"
        assert row["icon"] == "mdi-star"
        assert row["type"] == "selection"
        assert row["multi"] == 0
        assert row["required"] == 1
        assert json.loads(row["options"]) == [
            {"uuid": "opt-1", "name": "High", "sequence": 0},
        ]
        conn.close()

    def test_update_property_schema(self) -> None:
        ops = [
            make_operation("propertySchema.create", {"schemaId": "s-1", "name": "Old"}),
            make_operation(
                "propertySchema.update",
                {"schemaId": "s-1", "name": "New", "required": True, "multi": True},
                physical=2,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT name, required, multi FROM property_schema WHERE id = ?",
            ("s-1",),
        ).fetchone()
        assert row["name"] == "New"
        assert row["required"] == 1
        assert row["multi"] == 1
        conn.close()

    def test_delete_property_schema_sets_active_zero(self) -> None:
        ops = [
            make_operation("propertySchema.create", {"schemaId": "s-1", "name": "ToDelete"}),
            make_operation("propertySchema.delete", {"schemaId": "s-1"}, physical=2),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT active FROM property_schema WHERE id = ?", ("s-1",)
        ).fetchone()
        assert row["active"] == 0
        conn.close()

    def test_create_is_idempotent(self) -> None:
        op = make_operation("propertySchema.create", {"schemaId": "s-1", "name": "One"})
        conn = replay_operations([op, op])
        count = conn.execute(
            "SELECT COUNT(*) AS count FROM property_schema WHERE id = ?", ("s-1",)
        ).fetchone()["count"]
        assert count == 1
        conn.close()


class TestClassPropertyEdgeApplier:
    def test_create_edge(self) -> None:
        ops = [
            make_operation(
                "classPropertyEdge.create",
                {
                    "classId": "c-1",
                    "propertySchemaId": "s-1",
                    "sequence": 1,
                    "required": True,
                    "readonly": None,
                    "hideWhenEmpty": False,
                    "defaultValue": ["opt-1"],
                },
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT * FROM class_property_edge WHERE class_id = ? AND property_schema_id = ?",
            ("c-1", "s-1"),
        ).fetchone()
        assert row is not None
        assert row["sequence"] == 1
        assert row["required"] == 1
        assert row["readonly"] is None
        assert row["hide_when_empty"] == 0
        assert json.loads(row["default_value"]) == ["opt-1"]
        conn.close()

    def test_update_edge(self) -> None:
        ops = [
            make_operation(
                "classPropertyEdge.create",
                {"classId": "c-1", "propertySchemaId": "s-1", "sequence": 0},
            ),
            make_operation(
                "classPropertyEdge.update",
                {"classId": "c-1", "propertySchemaId": "s-1", "sequence": 2, "required": False},
                physical=2,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT sequence, required FROM class_property_edge WHERE class_id = ? AND property_schema_id = ?",
            ("c-1", "s-1"),
        ).fetchone()
        assert row["sequence"] == 2
        assert row["required"] == 0
        conn.close()

    def test_delete_edge(self) -> None:
        ops = [
            make_operation(
                "classPropertyEdge.create",
                {"classId": "c-1", "propertySchemaId": "s-1"},
            ),
            make_operation(
                "classPropertyEdge.delete",
                {"classId": "c-1", "propertySchemaId": "s-1"},
                physical=2,
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT COUNT(*) AS count FROM class_property_edge WHERE class_id = ? AND property_schema_id = ?",
            ("c-1", "s-1"),
        ).fetchone()
        assert row["count"] == 0
        conn.close()

    def test_reorder_edge(self) -> None:
        ops = [
            make_operation(
                "classPropertyEdge.create",
                {"classId": "c-1", "propertySchemaId": "s-1", "sequence": 0},
            ),
            make_operation(
                "classPropertyEdge.create",
                {"classId": "c-1", "propertySchemaId": "s-2", "sequence": 1},
            ),
            make_operation(
                "classPropertyEdge.reorder",
                {"classId": "c-1", "orderedPropertySchemaIds": ["s-2", "s-1"]},
                physical=3,
            ),
        ]
        conn = replay_operations(ops)
        rows = conn.execute(
            "SELECT property_schema_id, sequence FROM class_property_edge WHERE class_id = ? ORDER BY sequence",
            ("c-1",),
        ).fetchall()
        assert [(r["property_schema_id"], r["sequence"]) for r in rows] == [
            ("s-2", 0),
            ("s-1", 1),
        ]
        conn.close()


class TestPropertySchemaCleanupOnNodeDelete:
    def test_node_delete_cleans_property_schema_and_edges(self) -> None:
        ops = [
            make_operation("node.create", {"nodeId": "n-1", "kind": "class"}),
            make_operation(
                "propertySchema.create",
                {"schemaId": "s-1", "name": "Local", "nodeId": "n-1"},
                physical=2,
            ),
            make_operation(
                "classPropertyEdge.create",
                {"classId": "n-1", "propertySchemaId": "s-1"},
                physical=3,
            ),
            make_operation("node.delete", {"nodeId": "n-1"}, physical=4),
        ]
        conn = replay_operations(ops)
        schema_count = conn.execute(
            "SELECT COUNT(*) AS count FROM property_schema WHERE node_id = ?", ("n-1",)
        ).fetchone()["count"]
        edge_count = conn.execute(
            "SELECT COUNT(*) AS count FROM class_property_edge WHERE class_id = ?", ("n-1",)
        ).fetchone()["count"]
        assert schema_count == 0
        assert edge_count == 0
        conn.close()
