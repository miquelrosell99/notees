"""NodeView derived-state appliers."""

from __future__ import annotations

import json
import sqlite3

from app.core.operation import Operation


def _json(value: object) -> str:
    return json.dumps(value)


def _maybe_json(value: object | None) -> str | None:
    if value is None:
        return None
    return json.dumps(value)


def apply_node_view_create(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``nodeView.create`` operation."""
    payload = op.payload
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None
    conn.execute(
        """
        INSERT OR REPLACE INTO node_view (
            id, workspace_id, node_id, name, view_type, order_index, is_default,
            active, shown_properties, group_by, view_mode, sort_entries,
            settings, query_ast, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload["viewId"],
            op.envelope.workspace_id,
            payload["nodeId"],
            payload["name"],
            payload["viewType"],
            payload.get("orderIndex", 0),
            1 if payload.get("isDefault") else 0,
            1,
            _json(payload.get("shownProperties", [])),
            _maybe_json(payload.get("groupBy")),
            payload.get("viewMode"),
            _json(payload.get("sortEntries", [])),
            _json(payload.get("settings", {})),
            _maybe_json(payload.get("queryAst")),
            ts,
            ts,
        ),
    )


def apply_node_view_update(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``nodeView.update`` operation.

    The payload stores the full updated record; mutable columns are overwritten
    so that ``null`` clears a field and absent fields do not change.
    """
    payload = op.payload
    view_id = payload["viewId"]
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    columns: list[str] = []
    values: list[object] = []

    def add(column: str, value: object) -> None:
        columns.append(f"{column} = ?")
        values.append(value)

    if "name" in payload:
        add("name", payload["name"])
    if "orderIndex" in payload:
        add("order_index", payload["orderIndex"])
    if "isDefault" in payload:
        add("is_default", 1 if payload["isDefault"] else 0)
    if "shownProperties" in payload:
        add("shown_properties", _json(payload["shownProperties"]))
    if "groupBy" in payload:
        add("group_by", _maybe_json(payload["groupBy"]))
    if "viewMode" in payload:
        add("view_mode", payload["viewMode"])
    if "sortEntries" in payload:
        add("sort_entries", _json(payload["sortEntries"]))
    if "settings" in payload:
        add("settings", _json(payload["settings"]))
    if "queryAst" in payload:
        add("query_ast", _maybe_json(payload["queryAst"]))

    if not columns:
        return

    add("updated_at", ts)
    values.append(view_id)

    conn.execute(
        f"UPDATE node_view SET {', '.join(columns)} WHERE id = ?",
        values,
    )


def apply_node_view_delete(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``nodeView.delete`` operation."""
    conn.execute(
        "DELETE FROM node_view WHERE id = ?",
        (op.payload["viewId"],),
    )


def apply_node_view_reorder(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``nodeView.reorder`` operation."""
    payload = op.payload
    node_id = payload["nodeId"]
    view_type = payload["viewType"]
    ordered_ids = payload.get("orderedViewIds", [])
    for idx, view_id in enumerate(ordered_ids):
        conn.execute(
            """
            UPDATE node_view
            SET order_index = ?
            WHERE node_id = ? AND view_type = ? AND id = ?
            """,
            (idx, node_id, view_type, view_id),
        )


def delete_node_views_for_node(conn: sqlite3.Connection, node_id: str) -> None:
    """Remove all node_view rows belonging to ``node_id``."""
    conn.execute("DELETE FROM node_view WHERE node_id = ?", (node_id,))
