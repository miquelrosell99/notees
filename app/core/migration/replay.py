"""Replay ideal operations into a SQLite derived-state database.

This module is a minimal Python port of the TypeScript derived-state appliers in
``frontend/src/core/derived/``. It is used by the migration validation suite to
verify that operations generated from PostgreSQL produce a consistent SQLite
derived state.

The schema mirrors ``frontend/src/core/db/schema.ts`` but keeps only the tables
needed for reconciliation: ``node``, ``node_child_order``, ``property_value``,
``property_value_tombstone``, ``edge``, ``search_index`` and ``crdt_state``.
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

from app.core.operation import Operation
from app.core.uuid import uuidv7

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS node (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('page', 'block', 'class')),
    class_ids TEXT NOT NULL DEFAULT '[]',
    parent_id TEXT,
    content TEXT NOT NULL DEFAULT '[]',
    created_at TEXT,
    updated_at TEXT,
    created_by TEXT,
    updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_node_workspace ON node (workspace_id);
CREATE INDEX IF NOT EXISTS idx_node_parent ON node (parent_id);

CREATE TABLE IF NOT EXISTS node_child_order (
    parent_id TEXT NOT NULL,
    child_id TEXT NOT NULL,
    position TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id)
);

CREATE INDEX IF NOT EXISTS idx_node_child_order_parent
    ON node_child_order (parent_id);

CREATE TABLE IF NOT EXISTS property_value (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    property_schema_id TEXT NOT NULL,
    value TEXT NOT NULL,
    idx INTEGER NOT NULL DEFAULT 0,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    UNIQUE(node_id, property_schema_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_property_value_node
    ON property_value (node_id);

CREATE TABLE IF NOT EXISTS property_value_tombstone (
    node_id TEXT NOT NULL,
    property_schema_id TEXT NOT NULL,
    idx INTEGER NOT NULL DEFAULT 0,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    PRIMARY KEY (node_id, property_schema_id, idx)
);

CREATE TABLE IF NOT EXISTS edge (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type TEXT NOT NULL,
    property_schema_id TEXT,
    metadata TEXT,
    created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_edge_source ON edge (source_id);
CREATE INDEX IF NOT EXISTS idx_edge_target ON edge (target_id);

CREATE TABLE IF NOT EXISTS search_index (
    node_id TEXT PRIMARY KEY,
    content TEXT
);

CREATE TABLE IF NOT EXISTS crdt_state (
    node_id TEXT PRIMARY KEY,
    text_state BLOB,
    tree_state BLOB
);
"""


def create_derived_schema(conn: sqlite3.Connection) -> None:
    """Create the derived-state tables in ``conn``."""
    conn.executescript(SCHEMA_SQL)
    conn.commit()


def _node_exists(conn: sqlite3.Connection, node_id: str | None) -> bool:
    if node_id is None:
        return True
    row = conn.execute("SELECT 1 FROM node WHERE id = ?", (node_id,)).fetchone()
    return row is not None


def _extract_plaintext(content: list[dict[str, Any]]) -> str:
    """Return a plain-text rendering of a content AST for search indexing."""
    parts: list[str] = []
    for child in content:
        if isinstance(child, dict) and child.get("type") == "text" and isinstance(child.get("text"), str):
            parts.append(child["text"])
    return " ".join(parts)


def _reindex_node(conn: sqlite3.Connection, node_id: str) -> None:
    row = conn.execute("SELECT content FROM node WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        return
    content = json.loads(row[0])
    plaintext = _extract_plaintext(content)
    conn.execute("DELETE FROM search_index WHERE node_id = ?", (node_id,))
    if plaintext:
        conn.execute(
            "INSERT INTO search_index (node_id, content) VALUES (?, ?)",
            (node_id, plaintext),
        )


def _extract_ref_targets(content: list[dict[str, Any]]) -> dict[str, str | None]:
    """Return map target_id -> label from inline refs in the content AST."""
    targets: dict[str, str | None] = {}

    def _visit(node: Any) -> None:
        if not isinstance(node, dict):
            return
        ctype = node.get("type")
        if ctype == "ref" and node.get("targetId"):
            targets[node["targetId"]] = node.get("label")
        elif ctype == "node_link" and node.get("link_id"):
            # Migrated node_link entries store the target in the first segment of
            # ``link_id`` (``target`` or ``target:linkUuid``).
            link_id = str(node["link_id"])
            target_id = link_id.split(":", 1)[0]
            if target_id:
                targets[target_id] = node.get("label")
        elif ctype == "text" and isinstance(node.get("text"), str):
            text = node["text"]
            for match in re.finditer(r"\[\[([^\]]+)\]\]", text):
                targets[match.group(1)] = None
        children = node.get("children")
        if isinstance(children, list):
            for child in children:
                _visit(child)

    for child in content:
        _visit(child)
    return targets


def _rebuild_edges_for_node(conn: sqlite3.Connection, op: Operation) -> None:
    node_id = op.payload["nodeId"]
    workspace_id = op.envelope.workspace_id
    row = conn.execute("SELECT content FROM node WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        return
    content = json.loads(row[0])
    desired = _extract_ref_targets(content)

    existing = conn.execute(
        "SELECT id, target_id, metadata FROM edge WHERE source_id = ? AND type = ?",
        (node_id, "reference"),
    ).fetchall()
    existing_targets = {row["target_id"]: row for row in existing}

    for target_id, metadata in desired.items():
        if target_id in existing_targets:
            continue
        conn.execute(
            "INSERT INTO edge (id, workspace_id, source_id, target_id, type, property_schema_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                uuidv7(),
                workspace_id,
                node_id,
                target_id,
                "reference",
                None,
                json.dumps({"label": metadata}),
                op.envelope.timestamp.isoformat() if op.envelope.timestamp else None,
            ),
        )

    for target_id, row in existing_targets.items():
        if target_id not in desired:
            conn.execute("DELETE FROM edge WHERE id = ?", (row["id"],))


def _apply_node_create(conn: sqlite3.Connection, op: Operation) -> None:
    payload = op.payload
    node_id = payload["nodeId"]
    kind = payload["kind"]
    parent_id = payload.get("parentId")
    class_ids = payload.get("classIds") or []
    initial_content = payload.get("initialContent") or []
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    conn.execute(
        """
        INSERT OR IGNORE INTO node (
            id, workspace_id, kind, class_ids, parent_id, content,
            created_at, updated_at, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            node_id,
            op.envelope.workspace_id,
            kind,
            json.dumps(class_ids),
            parent_id,
            json.dumps(initial_content),
            ts,
            ts,
            op.envelope.actor_id,
            op.envelope.actor_id,
        ),
    )
    _reindex_node(conn, node_id)
    _rebuild_edges_for_node(conn, op)

    if parent_id is not None:
        position = str(payload.get("index", "0"))
        conn.execute(
            """
            INSERT OR REPLACE INTO node_child_order (parent_id, child_id, position)
            VALUES (?, ?, ?)
            """,
            (parent_id, node_id, position),
        )


def _apply_node_delete(conn: sqlite3.Connection, op: Operation) -> None:
    node_id = op.payload["nodeId"]
    conn.execute("DELETE FROM node WHERE id = ?", (node_id,))
    conn.execute(
        "DELETE FROM node_child_order WHERE parent_id = ? OR child_id = ?",
        (node_id, node_id),
    )
    conn.execute("DELETE FROM property_value WHERE node_id = ?", (node_id,))
    conn.execute("DELETE FROM property_value_tombstone WHERE node_id = ?", (node_id,))
    conn.execute(
        "DELETE FROM edge WHERE source_id = ? OR target_id = ?",
        (node_id, node_id),
    )
    conn.execute("DELETE FROM crdt_state WHERE node_id = ?", (node_id,))
    conn.execute("DELETE FROM search_index WHERE node_id = ?", (node_id,))


def _apply_node_move(conn: sqlite3.Connection, op: Operation) -> None:
    payload = op.payload
    node_id = payload["nodeId"]
    new_parent_id = payload.get("newParentId")
    position = str(payload.get("newIndex", "0"))
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    conn.execute(
        "UPDATE node SET parent_id = ?, updated_at = ?, updated_by = ? WHERE id = ?",
        (new_parent_id, ts, op.envelope.actor_id, node_id),
    )

    # Remove any existing child-order entry for this node.
    conn.execute("DELETE FROM node_child_order WHERE child_id = ?", (node_id,))

    if new_parent_id is not None:
        conn.execute(
            """
            INSERT OR REPLACE INTO node_child_order (parent_id, child_id, position)
            VALUES (?, ?, ?)
            """,
            (new_parent_id, node_id, position),
        )


def _apply_class_assign(conn: sqlite3.Connection, op: Operation) -> None:
    payload = op.payload
    node_id = payload["nodeId"]
    class_id = payload["classId"]
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    row = conn.execute(
        "SELECT class_ids FROM node WHERE id = ?", (node_id,)
    ).fetchone()
    if row is None:
        return

    ids = set(json.loads(row[0]))
    ids.add(class_id)
    conn.execute(
        "UPDATE node SET class_ids = ?, updated_at = ?, updated_by = ? WHERE id = ?",
        (json.dumps(sorted(ids)), ts, op.envelope.actor_id, node_id),
    )


def _apply_class_unassign(conn: sqlite3.Connection, op: Operation) -> None:
    payload = op.payload
    node_id = payload["nodeId"]
    class_id = payload["classId"]
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    row = conn.execute(
        "SELECT class_ids FROM node WHERE id = ?", (node_id,)
    ).fetchone()
    if row is None:
        return

    ids = set(json.loads(row[0]))
    ids.discard(class_id)
    conn.execute(
        "UPDATE node SET class_ids = ?, updated_at = ?, updated_by = ? WHERE id = ?",
        (json.dumps(sorted(ids)), ts, op.envelope.actor_id, node_id),
    )


def _apply_node_update_content(conn: sqlite3.Connection, op: Operation) -> None:
    payload = op.payload
    node_id = payload["nodeId"]
    crdt_update = payload.get("crdtUpdate")
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    # Migration emits a simplified content AST under ``crdtUpdate`` rather than a
    # binary Yjs update. Treat it as the node content directly.
    if isinstance(crdt_update, list):
        content = crdt_update
    elif isinstance(crdt_update, dict):
        content = [crdt_update]
    else:
        content = []

    conn.execute(
        "UPDATE node SET content = ?, updated_at = ?, updated_by = ? WHERE id = ?",
        (json.dumps(content), ts, op.envelope.actor_id, node_id),
    )
    _reindex_node(conn, node_id)
    _rebuild_edges_for_node(conn, op)


def _compare_hlc(a: dict[str, Any], b: dict[str, Any]) -> int:
    if a["physical"] != b["physical"]:
        return a["physical"] - b["physical"]
    return a["logical"] - b["logical"]


def _record_from_row(row: sqlite3.Row | None, fallback_actor: str) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "physical": row["hlc_physical"],
        "logical": row["hlc_logical"],
        "actor_id": row["actor_id"] or fallback_actor,
    }


def _apply_property_set(conn: sqlite3.Connection, op: Operation) -> None:
    payload = op.payload
    node_id = payload["nodeId"]
    schema_id = payload["schemaId"]
    idx = payload.get("index", 0)
    value = payload["value"]
    property_value_id = payload["propertyValueId"]
    incoming: dict[str, Any] = {
        "physical": op.envelope.hlc.physical,
        "logical": op.envelope.hlc.logical,
        "actor_id": op.envelope.actor_id,
    }

    existing_row = conn.execute(
        """
        SELECT id, hlc_physical, hlc_logical, actor_id
        FROM property_value
        WHERE node_id = ? AND property_schema_id = ? AND idx = ?
        """,
        (node_id, schema_id, idx),
    ).fetchone()

    tombstone_row = conn.execute(
        """
        SELECT hlc_physical, hlc_logical, actor_id
        FROM property_value_tombstone
        WHERE node_id = ? AND property_schema_id = ? AND idx = ?
        """,
        (node_id, schema_id, idx),
    ).fetchone()

    existing = _record_from_row(existing_row, incoming["actor_id"])
    tombstone = _record_from_row(tombstone_row, incoming["actor_id"])

    if tombstone is not None and _compare_hlc(incoming, tombstone) <= 0:
        return

    if existing is not None:
        if _compare_hlc(incoming, existing) > 0:
            conn.execute(
                """
                UPDATE property_value
                SET value = ?, hlc_physical = ?, hlc_logical = ?, actor_id = ?
                WHERE node_id = ? AND property_schema_id = ? AND idx = ?
                """,
                (
                    json.dumps(value),
                    incoming["physical"],
                    incoming["logical"],
                    incoming["actor_id"],
                    node_id,
                    schema_id,
                    idx,
                ),
            )
    else:
        conn.execute(
            """
            INSERT INTO property_value (
                id, node_id, property_schema_id, value, idx,
                hlc_physical, hlc_logical, actor_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                property_value_id,
                node_id,
                schema_id,
                json.dumps(value),
                idx,
                incoming["physical"],
                incoming["logical"],
                incoming["actor_id"],
            ),
        )


def _apply_property_unset(conn: sqlite3.Connection, op: Operation) -> None:
    payload = op.payload
    node_id = payload["nodeId"]
    schema_id = payload["schemaId"]
    idx = payload.get("index", 0)
    incoming: dict[str, Any] = {
        "physical": op.envelope.hlc.physical,
        "logical": op.envelope.hlc.logical,
        "actor_id": op.envelope.actor_id,
    }

    existing_row = conn.execute(
        """
        SELECT hlc_physical, hlc_logical, actor_id
        FROM property_value
        WHERE node_id = ? AND property_schema_id = ? AND idx = ?
        """,
        (node_id, schema_id, idx),
    ).fetchone()
    existing = _record_from_row(existing_row, incoming["actor_id"])

    conn.execute(
        """
        INSERT INTO property_value_tombstone (
            node_id, property_schema_id, idx, hlc_physical, hlc_logical, actor_id
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id, property_schema_id, idx) DO UPDATE SET
            hlc_physical = excluded.hlc_physical,
            hlc_logical = excluded.hlc_logical,
            actor_id = excluded.actor_id
        WHERE excluded.hlc_physical > hlc_physical
           OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
           OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical
               AND excluded.actor_id > actor_id)
        """,
        (
            node_id,
            schema_id,
            idx,
            incoming["physical"],
            incoming["logical"],
            incoming["actor_id"],
        ),
    )

    if existing is not None and _compare_hlc(incoming, existing) > 0:
        conn.execute(
            """
            DELETE FROM property_value
            WHERE node_id = ? AND property_schema_id = ? AND idx = ?
            """,
            (node_id, schema_id, idx),
        )


def _apply_property_schema_create(conn: sqlite3.Connection, op: Operation) -> None:
    """Property schemas are not materialized in the derived node tables."""


def _apply_property_schema_update(conn: sqlite3.Connection, op: Operation) -> None:
    """Property schema updates do not affect derived reconciliation counts."""


def _apply_class_create(conn: sqlite3.Connection, op: Operation) -> None:
    """``class.create`` is equivalent to creating a node of kind ``class``."""
    payload = op.payload
    node_id = payload["classId"]
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None
    conn.execute(
        """
        INSERT OR IGNORE INTO node (
            id, workspace_id, kind, class_ids, parent_id, content,
            created_at, updated_at, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            node_id,
            op.envelope.workspace_id,
            "class",
            "[]",
            None,
            "[]",
            ts,
            ts,
            op.envelope.actor_id,
            op.envelope.actor_id,
        ),
    )


def _apply_class_update(conn: sqlite3.Connection, op: Operation) -> None:
    """Class updates do not affect derived reconciliation counts."""


def apply_operation(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a single operation to the derived SQLite state in ``conn``."""
    op_type = op.envelope.op_type
    if op_type == "node.create":
        _apply_node_create(conn, op)
    elif op_type == "node.delete":
        _apply_node_delete(conn, op)
    elif op_type == "node.move":
        _apply_node_move(conn, op)
    elif op_type == "node.updateContent":
        _apply_node_update_content(conn, op)
    elif op_type == "class.assign":
        _apply_class_assign(conn, op)
    elif op_type == "class.unassign":
        _apply_class_unassign(conn, op)
    elif op_type == "property.set":
        _apply_property_set(conn, op)
    elif op_type == "property.unset":
        _apply_property_unset(conn, op)
    elif op_type == "propertySchema.create":
        _apply_property_schema_create(conn, op)
    elif op_type == "propertySchema.update":
        _apply_property_schema_update(conn, op)
    elif op_type == "class.create":
        _apply_class_create(conn, op)
    elif op_type == "class.update":
        _apply_class_update(conn, op)
    else:
        raise ValueError(f"Unsupported op_type: {op_type!r}")


def replay_operations(
    operations: list[Operation],
    db_path: str | Path | None = None,
) -> sqlite3.Connection:
    """Replay ``operations`` into a SQLite database.

    Args:
        operations: Operations to apply, in the order they should be replayed.
        db_path: Path to a SQLite file. If ``None``, an in-memory database is
            used and returned.

    Returns:
        A ``sqlite3.Connection`` to the database containing the derived state.
    """
    if db_path is None:
        conn = sqlite3.connect(":memory:")
    else:
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    create_derived_schema(conn)
    for operation in operations:
        apply_operation(conn, operation)
    conn.commit()
    return conn
