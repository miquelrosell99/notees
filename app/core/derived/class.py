# noqa: N999  # ``class`` is a reserved keyword but matches the task-specified module path.
"""Derived-state applier that materialises the dedicated ``class`` table.

Classes are now stored in their own table; ``node.kind`` is only ``page`` or
``block``. Class metadata is maintained exclusively by ``class.*`` operations.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from app.core.operation import Operation

from .class_hierarchy import apply_class_hierarchy


def _timestamp_from_op(op: Operation) -> str | None:
    return op.envelope.timestamp.isoformat() if op.envelope.timestamp else None


def _normalize_class_name(name: Any) -> str:
    """Return a plain-text class name.

    Some class.create payloads (especially from imports) store the name as a
    JSON-encoded AST string like ``'[{"type":"paragraph",...}]'`` instead of
    plain text. Parse that and extract the text so the class catalogue renders
    correctly and search/sort work as expected.
    """
    if not isinstance(name, str):
        return "Untitled class"
    name = name.strip()
    if not name:
        return "Untitled class"
    if name.startswith("["):
        try:
            ast = json.loads(name)
        except json.JSONDecodeError:
            return name
        if isinstance(ast, list):
            parts: list[str] = []
            _collect_text(ast, parts)
            return "".join(parts).strip() or "Untitled class"
    return name


def _collect_text(value: Any, parts: list[str]) -> None:
    """Recursively collect text from an AST document or inline node."""
    if isinstance(value, list):
        for item in value:
            _collect_text(item, parts)
    elif isinstance(value, dict):
        if value.get("type") == "text" and isinstance(value.get("text"), str):
            parts.append(value["text"])
        for children in value.get("children", []):
            _collect_text(children, parts)


def apply_class_operation(conn: sqlite3.Connection, op: Operation) -> None:
    """Maintain the ``class`` table from class operations."""
    op_type = op.envelope.op_type
    payload = op.payload
    ts = _timestamp_from_op(op)

    if op_type == "class.create":
        class_id = payload["classId"]
        name = _normalize_class_name(payload.get("name", "Untitled class"))
        icon = payload.get("icon")
        color = payload.get("color")

        conn.execute(
            """
            INSERT OR REPLACE INTO class (
                id, workspace_id, name, icon, color, description,
                extends_class_ids, active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                class_id,
                op.envelope.workspace_id,
                name,
                icon,
                color,
                None,
                "[]",
                1,
                ts,
                ts,
            ),
        )

    elif op_type == "class.update":
        class_id = payload["classId"]
        sets: list[str] = []
        values: list[Any] = []

        if "name" in payload:
            sets.append("name = ?")
            values.append(_normalize_class_name(payload["name"]))
        if "icon" in payload:
            sets.append("icon = ?")
            values.append(payload["icon"])
        if "color" in payload:
            sets.append("color = ?")
            values.append(payload["color"])
        if "description" in payload:
            sets.append("description = ?")
            values.append(payload["description"])

        if not sets:
            return

        sets.append("updated_at = ?")
        values.append(ts)
        values.append(class_id)

        conn.execute(
            f"UPDATE class SET {', '.join(sets)} WHERE id = ?",
            values,
        )

    elif op_type == "class.delete":
        class_id = payload["classId"]
        conn.execute(
            "UPDATE class SET active = 0, updated_at = ? WHERE id = ?",
            (ts, class_id),
        )

    elif op_type == "class.setExtends":
        class_id = payload["classId"]
        extends = payload.get("extendsClassIds", [])
        extends_list = extends if isinstance(extends, list) else []

        conn.execute(
            "UPDATE class SET extends_class_ids = ?, updated_at = ? WHERE id = ?",
            (json.dumps(extends_list), ts, class_id),
        )
        apply_class_hierarchy(conn, class_id, extends_list)
