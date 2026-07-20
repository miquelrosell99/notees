"""Property-value and property-schema derived-state appliers."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from app.core.operation import Operation


def _compare_hlc(a: dict[str, Any], b: dict[str, Any]) -> int:
    """Compare two HLC dicts; positive if ``a`` is newer."""
    if a["physical"] != b["physical"]:
        return a["physical"] - b["physical"]
    return a["logical"] - b["logical"]


def _record_from_row(
    row: sqlite3.Row | None,
    fallback_actor: str,
) -> dict[str, Any] | None:
    """Build an LWW record from a property_value or tombstone row."""
    if row is None:
        return None
    return {
        "physical": row["hlc_physical"],
        "logical": row["hlc_logical"],
        "actor_id": row["actor_id"] or fallback_actor,
    }


def apply_property_set(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``property.set`` operation using LWW ordering."""
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


def apply_property_unset(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``property.unset`` operation using LWW ordering."""
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


def _json_or_null(value: Any) -> str | None:
    """Serialize a value to JSON, returning ``None`` for ``None``."""
    if value is None:
        return None
    return json.dumps(value)


def _bool_to_int(value: bool | None) -> int | None:
    """Convert a tri-state boolean to 0/1/NULL."""
    if value is None:
        return None
    return 1 if value else 0


def apply_property_schema_create(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``propertySchema.create`` operation."""
    payload = op.payload
    schema_id = payload["schemaId"]
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None
    conn.execute(
        """
        INSERT OR REPLACE INTO property_schema (
            id, workspace_id, name, icon, type, multi, is_system, scope, node_id,
            icon_visibility, validation_rules, required, readonly, hide_when_empty,
            default_value, class_filter_uuids, options, computed, active,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            schema_id,
            op.envelope.workspace_id,
            payload["name"],
            payload.get("icon"),
            payload.get("type") or "text",
            1 if payload.get("multi") else 0,
            1 if payload.get("isSystem") else 0,
            payload.get("scope") or "global",
            payload.get("nodeId"),
            payload.get("iconVisibility"),
            _json_or_null(payload.get("validationRules")),
            1 if payload.get("required") else 0,
            1 if payload.get("readonly") else 0,
            1 if payload.get("hideWhenEmpty") else 0,
            _json_or_null(payload.get("defaultValue")),
            _json_or_null(payload.get("classFilterUuids") or []),
            _json_or_null(payload.get("options") or []),
            _json_or_null(payload.get("computed")),
            1,
            ts,
            ts,
        ),
    )


def apply_property_schema_update(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``propertySchema.update`` operation."""
    payload = op.payload
    schema_id = payload["schemaId"]
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    columns: list[str] = []
    values: list[Any] = []

    if "name" in payload:
        columns.append("name = ?")
        values.append(payload["name"])
    if "icon" in payload:
        columns.append("icon = ?")
        values.append(payload["icon"])
    if "type" in payload:
        columns.append("type = ?")
        values.append(payload["type"] or "text")
    if "multi" in payload:
        columns.append("multi = ?")
        values.append(1 if payload["multi"] else 0)
    if "scope" in payload:
        columns.append("scope = ?")
        values.append(payload["scope"] or "global")
    if "nodeId" in payload:
        columns.append("node_id = ?")
        values.append(payload["nodeId"])
    if "iconVisibility" in payload:
        columns.append("icon_visibility = ?")
        values.append(payload["iconVisibility"])
    if "validationRules" in payload:
        columns.append("validation_rules = ?")
        values.append(_json_or_null(payload["validationRules"]))
    if "required" in payload:
        columns.append("required = ?")
        values.append(1 if payload["required"] else 0)
    if "readonly" in payload:
        columns.append("readonly = ?")
        values.append(1 if payload["readonly"] else 0)
    if "hideWhenEmpty" in payload:
        columns.append("hide_when_empty = ?")
        values.append(1 if payload["hideWhenEmpty"] else 0)
    if "defaultValue" in payload:
        columns.append("default_value = ?")
        values.append(_json_or_null(payload["defaultValue"]))
    if "classFilterUuids" in payload:
        columns.append("class_filter_uuids = ?")
        values.append(_json_or_null(payload["classFilterUuids"] or []))
    if "options" in payload:
        columns.append("options = ?")
        values.append(_json_or_null(payload["options"] or []))
    if "computed" in payload:
        columns.append("computed = ?")
        values.append(_json_or_null(payload["computed"]))

    if not columns:
        return

    columns.append("updated_at = ?")
    values.append(ts)
    values.append(schema_id)

    conn.execute(
        f"UPDATE property_schema SET {', '.join(columns)} WHERE id = ?",
        values,
    )


def apply_property_schema_delete(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``propertySchema.delete`` operation (soft delete)."""
    payload = op.payload
    schema_id = payload["schemaId"]
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None
    conn.execute(
        "UPDATE property_schema SET active = 0, updated_at = ? WHERE id = ?",
        (ts, schema_id),
    )


def apply_class_property_edge_create(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``classPropertyEdge.create`` operation."""
    payload = op.payload
    class_id = payload["classId"]
    property_schema_id = payload["propertySchemaId"]
    conn.execute(
        """
        INSERT OR REPLACE INTO class_property_edge (
            class_id, property_schema_id, sequence, default_value, hidden,
            required, readonly, hide_when_empty
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            class_id,
            property_schema_id,
            payload.get("sequence", 0),
            _json_or_null(payload.get("defaultValue")),
            1 if payload.get("hidden") else 0,
            _bool_to_int(payload.get("required")),
            _bool_to_int(payload.get("readonly")),
            _bool_to_int(payload.get("hideWhenEmpty")),
        ),
    )


def apply_class_property_edge_update(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``classPropertyEdge.update`` operation."""
    payload = op.payload
    class_id = payload["classId"]
    property_schema_id = payload["propertySchemaId"]

    columns: list[str] = []
    values: list[Any] = []

    if "sequence" in payload:
        columns.append("sequence = ?")
        values.append(payload["sequence"])
    if "defaultValue" in payload:
        columns.append("default_value = ?")
        values.append(_json_or_null(payload["defaultValue"]))
    if "hidden" in payload:
        columns.append("hidden = ?")
        values.append(1 if payload["hidden"] else 0)
    if "required" in payload:
        columns.append("required = ?")
        values.append(_bool_to_int(payload["required"]))
    if "readonly" in payload:
        columns.append("readonly = ?")
        values.append(_bool_to_int(payload["readonly"]))
    if "hideWhenEmpty" in payload:
        columns.append("hide_when_empty = ?")
        values.append(_bool_to_int(payload["hideWhenEmpty"]))

    if not columns:
        return

    values.extend([class_id, property_schema_id])
    conn.execute(
        f"UPDATE class_property_edge SET {', '.join(columns)} WHERE class_id = ? AND property_schema_id = ?",
        values,
    )


def apply_class_property_edge_delete(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``classPropertyEdge.delete`` operation."""
    payload = op.payload
    conn.execute(
        "DELETE FROM class_property_edge WHERE class_id = ? AND property_schema_id = ?",
        (payload["classId"], payload["propertySchemaId"]),
    )


def apply_class_property_edge_reorder(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``classPropertyEdge.reorder`` operation."""
    payload = op.payload
    class_id = payload["classId"]
    for sequence, property_schema_id in enumerate(payload.get("orderedPropertySchemaIds", [])):
        conn.execute(
            "UPDATE class_property_edge SET sequence = ? WHERE class_id = ? AND property_schema_id = ?",
            (sequence, class_id, property_schema_id),
        )
