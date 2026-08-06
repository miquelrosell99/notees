"""Unit tests for migration validation and reconciliation."""

from __future__ import annotations

from uuid import uuid4

import pytest

from app.core.clock import Hlc
from app.core.migration.validation import (
    DerivedCounts,
    build_reconciliation_report,
    compare_derived_state,
    detect_duplicate_operations,
    detect_orphan_operations,
    format_report,
    get_derived_counts,
    replay_operations,
)
from app.core.operation import Operation, OperationEnvelope

pytestmark = pytest.mark.unit


def _make_operation(
    op_type: str,
    payload: dict,
    *,
    op_id: str | None = None,
    workspace_id: str = "ws-1",
    actor_id: str = "actor-1",
    physical: int = 1,
    logical: int = 0,
) -> Operation:
    return Operation(
        envelope=OperationEnvelope(
            id=op_id or uuid4().hex,
            workspace_id=workspace_id,
            actor_id=actor_id,
            hlc=Hlc(physical=physical, logical=logical),
            affected_node_ids=[payload.get("nodeId", payload.get("classId", "n-1"))],
            op_type=op_type,
        ),
        payload=payload,
    )


class TestReplayOperations:
    def test_replay_creates_nodes(self) -> None:
        ops = [
            _make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": "0"}),
            _make_operation("node.create", {"nodeId": "n-2", "kind": "block", "index": "0"}),
        ]
        conn = replay_operations(ops)
        count = conn.execute("SELECT COUNT(*) FROM node").fetchone()[0]
        assert count == 2
        conn.close()

    def test_replay_applies_parent_and_child_order(self) -> None:
        ops = [
            _make_operation("node.create", {"nodeId": "parent", "kind": "page", "index": "0"}),
            _make_operation(
                "node.create",
                {"nodeId": "child", "kind": "block", "parentId": "parent", "index": "1"},
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT parent_id FROM node WHERE id = ?", ("child",)
        ).fetchone()
        assert row["parent_id"] == "parent"

        edge = conn.execute(
            "SELECT * FROM node_child_order WHERE parent_id = ? AND child_id = ?",
            ("parent", "child"),
        ).fetchone()
        assert edge is not None
        assert edge["position"] == "1"
        conn.close()

    def test_replay_class_assign_updates_class_ids(self) -> None:
        ops = [
            _make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": "0"}),
            _make_operation("class.assign", {"nodeId": "n-1", "classId": "class-1"}),
        ]
        conn = replay_operations(ops)
        row = conn.execute("SELECT class_ids FROM node WHERE id = ?", ("n-1",)).fetchone()
        assert "class-1" in row["class_ids"]
        conn.close()

    def test_replay_update_content_indexes_text(self) -> None:
        ops = [
            _make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": "0"}),
            _make_operation(
                "node.updateContent",
                {"nodeId": "n-1", "crdtUpdate": [{"type": "text", "text": "hello world"}]},
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute("SELECT content FROM node WHERE id = ?", ("n-1",)).fetchone()
        content = __import__("json").loads(row["content"])
        assert content == [{"type": "text", "text": "hello world"}]

        search = conn.execute(
            "SELECT content FROM search_index WHERE node_id = ?", ("n-1",)
        ).fetchone()
        assert search["content"] == "hello world"
        conn.close()

    def test_replay_delete_removes_node_and_edges(self) -> None:
        ops = [
            _make_operation("node.create", {"nodeId": "parent", "kind": "page", "index": "0"}),
            _make_operation(
                "node.create",
                {"nodeId": "child", "kind": "block", "parentId": "parent", "index": "0"},
            ),
            _make_operation("node.delete", {"nodeId": "child"}),
        ]
        conn = replay_operations(ops)
        assert conn.execute("SELECT 1 FROM node WHERE id = ?", ("child",)).fetchone() is None
        assert conn.execute(
            "SELECT 1 FROM node_child_order WHERE child_id = ?", ("child",)
        ).fetchone() is None
        conn.close()


class TestDerivedCounts:
    def test_get_derived_counts(self) -> None:
        ops = [
            _make_operation("node.create", {"nodeId": "p", "kind": "page", "index": "0"}),
            _make_operation(
                "node.create",
                {"nodeId": "c", "kind": "block", "parentId": "p", "index": "0"},
            ),
            _make_operation(
                "property.set",
                {
                    "propertyValueId": "pv-1",
                    "nodeId": "c",
                    "schemaId": "schema-1",
                    "index": 0,
                    "value": "value",
                },
            ),
        ]
        conn = replay_operations(ops)
        counts = get_derived_counts(conn)
        assert counts.node_count == 2
        assert counts.hierarchy_edge_count == 1
        assert counts.property_count == 1
        assert counts.node_link_count == 0
        conn.close()

    def test_compare_derived_state(self) -> None:
        ops = [
            _make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": "0"}),
        ]
        conn = replay_operations(ops)
        errors = compare_derived_state(conn, DerivedCounts(1, 0, 0, 0))
        assert errors == []

        errors = compare_derived_state(conn, DerivedCounts(2, 0, 0, 0))
        assert len(errors) == 1
        assert "node count mismatch" in errors[0]
        conn.close()


class TestOrphanDetection:
    def test_no_orphans_for_valid_sequence(self) -> None:
        ops = [
            _make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": "0"}),
            _make_operation("node.move", {"nodeId": "n-1", "newParentId": "n-2", "newIndex": "0"}),
            _make_operation("node.create", {"nodeId": "n-2", "kind": "page", "index": "0"}),
        ]
        # n-2 is created after the move, so the move references an unknown node.
        assert len(detect_orphan_operations(ops)) == 1

    def test_extra_ids_prevent_orphan_reports(self) -> None:
        ops = [
            _make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": "0"}),
            _make_operation("class.assign", {"nodeId": "n-1", "classId": "system-class"}),
        ]
        assert detect_orphan_operations(ops) != []
        assert detect_orphan_operations(ops, extra_ids={"system-class"}) == []

    def test_create_ops_are_not_orphans(self) -> None:
        ops = [
            _make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": "0"}),
        ]
        assert detect_orphan_operations(ops) == []


class TestDuplicateDetection:
    def test_detects_duplicate_ids(self) -> None:
        shared_id = uuid4().hex
        ops = [
            _make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": "0"}, op_id=shared_id),
            _make_operation("node.create", {"nodeId": "n-2", "kind": "page", "index": "0"}, op_id=shared_id),
        ]
        dups = detect_duplicate_operations(ops)
        assert shared_id in dups
        assert len(dups[shared_id]) == 2

    def test_no_duplicates_for_unique_ids(self) -> None:
        ops = [
            _make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": "0"}),
            _make_operation("node.create", {"nodeId": "n-2", "kind": "page", "index": "0"}),
        ]
        assert detect_duplicate_operations(ops) == {}


class TestReconciliationReport:
    def test_build_report(self) -> None:
        ops = [
            _make_operation("node.create", {"nodeId": "p", "kind": "page", "index": "0"}),
            _make_operation(
                "node.create",
                {"nodeId": "c", "kind": "block", "parentId": "p", "index": "0"},
            ),
        ]
        report = build_reconciliation_report(
            ops, expected=DerivedCounts(node_count=2, hierarchy_edge_count=1, property_count=0, node_link_count=0)
        )
        assert report.operation_count == 2
        assert report.node_count == 2
        assert report.hierarchy_edge_count == 1
        assert report.orphan_count == 0
        assert report.duplicate_count == 0
        assert report.mismatch_errors == []

    def test_format_report_includes_counts(self) -> None:
        ops = [
            _make_operation("node.create", {"nodeId": "n-1", "kind": "page", "index": "0"}),
        ]
        report = build_reconciliation_report(ops)
        text = format_report(report)
        assert "Operations:" in text
        assert "Nodes:" in text
        assert "Orphan operations:" in text
