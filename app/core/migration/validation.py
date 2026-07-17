"""Validation and reconciliation helpers for the migration framework.

Provides functions to replay operations into a SQLite derived state, compare
counts against expected values, detect orphan operations, and report duplicates.
"""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from app.core.migration.replay import replay_operations
from app.core.operation import Operation


@dataclass
class DerivedCounts:
    """Aggregated counts from the derived SQLite state."""

    node_count: int
    hierarchy_edge_count: int
    property_count: int
    edge_count: int


@dataclass
class ReconciliationReport:
    """Full reconciliation report for a set of operations and derived state."""

    operation_count: int
    node_count: int
    hierarchy_edge_count: int
    property_count: int
    edge_count: int
    orphan_count: int
    duplicate_count: int
    mismatch_errors: list[str]


def get_derived_counts(conn: sqlite3.Connection) -> DerivedCounts:
    """Return aggregated counts from the derived SQLite database."""
    node_count = conn.execute("SELECT COUNT(*) FROM node").fetchone()[0]
    hierarchy_edge_count = conn.execute(
        "SELECT COUNT(*) FROM node_child_order"
    ).fetchone()[0]
    property_count = conn.execute(
        "SELECT COUNT(*) FROM property_value"
    ).fetchone()[0]
    edge_count = conn.execute("SELECT COUNT(*) FROM edge").fetchone()[0]
    return DerivedCounts(
        node_count=node_count,
        hierarchy_edge_count=hierarchy_edge_count,
        property_count=property_count,
        edge_count=edge_count,
    )


def compare_derived_state(
    conn: sqlite3.Connection,
    expected: DerivedCounts,
) -> list[str]:
    """Compare derived counts against ``expected``.

    Returns:
        A list of human-readable mismatch messages. Empty when counts match.
    """
    actual = get_derived_counts(conn)
    errors: list[str] = []
    if actual.node_count != expected.node_count:
        errors.append(
            f"node count mismatch: expected {expected.node_count}, got {actual.node_count}"
        )
    if actual.hierarchy_edge_count != expected.hierarchy_edge_count:
        errors.append(
            "hierarchy edge count mismatch: "
            f"expected {expected.hierarchy_edge_count}, got {actual.hierarchy_edge_count}"
        )
    if actual.property_count != expected.property_count:
        errors.append(
            f"property count mismatch: expected {expected.property_count}, got {actual.property_count}"
        )
    if actual.edge_count != expected.edge_count:
        errors.append(
            f"edge count mismatch: expected {expected.edge_count}, got {actual.edge_count}"
        )
    return errors


def _referenced_ids(op: Operation) -> set[str]:
    """Return every node-like id referenced by ``op``'s payload."""
    payload = op.payload
    refs: set[str] = set()

    # Node ids under various payload keys. schemaId is a property schema, not a
    # node, so it is intentionally excluded from orphan detection.
    for key in ("nodeId", "newParentId", "classId", "targetId", "sourceId"):
        value = payload.get(key)
        if isinstance(value, str):
            refs.add(value)

    # Legacy migration uses ``parentId``/``index`` on node.create.
    parent_id = payload.get("parentId")
    if isinstance(parent_id, str):
        refs.add(parent_id)

    class_ids = payload.get("classIds")
    if isinstance(class_ids, list):
        for item in class_ids:
            if isinstance(item, str):
                refs.add(item)

    return refs


def detect_orphan_operations(
    operations: list[Operation],
    *,
    extra_ids: set[str] | None = None,
) -> list[Operation]:
    """Return operations that reference nodes never created by earlier ops.

    Args:
        operations: Operations in replay order.
        extra_ids: Optional set of ids that are considered valid even when no
            ``node.create`` or ``class.create`` operation creates them. Useful
            for system-class ids generated outside the operation stream.

    Returns:
        The subset of ``operations`` whose payloads reference at least one id
        that is not in ``extra_ids`` and was not created by a preceding
        ``node.create`` or ``class.create`` operation.
    """
    known: set[str] = set(extra_ids) if extra_ids else set()
    orphans: list[Operation] = []

    for op in operations:
        refs = _referenced_ids(op)
        missing = refs - known
        if missing and op.envelope.op_type not in {"node.create", "class.create"}:
            orphans.append(op)
        if op.envelope.op_type == "node.create":
            known.add(op.payload.get("nodeId"))
        elif op.envelope.op_type == "class.create":
            known.add(op.payload.get("classId"))

    return orphans


def detect_duplicate_operations(
    operations: list[Operation],
) -> dict[str, list[Operation]]:
    """Return a map of duplicate operation ids to the operations sharing them."""
    buckets: dict[str, list[Operation]] = defaultdict(list)
    for op in operations:
        buckets[op.envelope.id].append(op)
    return {op_id: ops for op_id, ops in buckets.items() if len(ops) > 1}


def build_reconciliation_report(
    operations: list[Operation],
    db_path: str | Path | None = None,
    *,
    expected: DerivedCounts | None = None,
    extra_ids: set[str] | None = None,
) -> ReconciliationReport:
    """Replay operations and produce a reconciliation report.

    Args:
        operations: Operations to validate.
        db_path: Optional SQLite file path. Uses an in-memory database when
            ``None``.
        expected: Optional expected counts to compare against.
        extra_ids: Optional ids considered valid for orphan detection.

    Returns:
        A ``ReconciliationReport`` with counts and mismatch errors.
    """
    conn = replay_operations(operations, db_path=db_path)
    try:
        counts = get_derived_counts(conn)
        mismatch_errors = (
            compare_derived_state(conn, expected) if expected is not None else []
        )
        orphans = detect_orphan_operations(operations, extra_ids=extra_ids)
        duplicates = detect_duplicate_operations(operations)
        return ReconciliationReport(
            operation_count=len(operations),
            node_count=counts.node_count,
            hierarchy_edge_count=counts.hierarchy_edge_count,
            property_count=counts.property_count,
            edge_count=counts.edge_count,
            orphan_count=len(orphans),
            duplicate_count=len(duplicates),
            mismatch_errors=mismatch_errors,
        )
    finally:
        conn.close()


def format_report(report: ReconciliationReport) -> str:
    """Format a ``ReconciliationReport`` for console output."""
    lines = [
        "Migration Reconciliation Report",
        "-------------------------------",
        f"Operations:        {report.operation_count}",
        f"Nodes:             {report.node_count}",
        f"Hierarchy edges:   {report.hierarchy_edge_count}",
        f"Properties:        {report.property_count}",
        f"Edges:             {report.edge_count}",
        f"Orphan operations: {report.orphan_count}",
        f"Duplicate ids:     {report.duplicate_count}",
    ]
    if report.mismatch_errors:
        lines.append("")
        lines.append("Mismatches:")
        for error in report.mismatch_errors:
            lines.append(f"  - {error}")
    return "\n".join(lines)
