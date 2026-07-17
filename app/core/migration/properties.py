"""Migrate properties, property schemas, and classes from the current PostgreSQL
schema to ideal operations.

This module covers Phase 2.B2: it reads the legacy ``property``,
``property_value_scalar``, ``property_value_relation``,
``property_value_selection``, ``property_selection_line``, ``node_property``,
``class_property``, and ``class_extend`` tables and emits
``propertySchema.create``, ``property.set``, and ``class.create`` operations.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

import asyncpg

from app.core.migration.nodes import MigrationContext
from app.core.operation import Operation, create_operation
from app.core.uuid import uuidv7

# Legacy property.type -> ideal propertySchema.type.
PROPERTY_TYPE_MAP: dict[str, str] = {
    "text": "text",
    "integer": "number",
    "float": "number",
    "date": "date",
    "date_range": "date",
    "selection": "select",
    "node": "node",
    "boolean": "checkbox",
    "url": "text",
    "email": "text",
    "image": "file",
}


def _is_valid_uuid(value: Any) -> bool:
    """Return True if ``value`` is a valid UUID (object or string)."""
    if isinstance(value, UUID):
        return True
    if not isinstance(value, str):
        return False
    try:
        UUID(value)
    except ValueError:
        return False
    return True


def _schema_uuid(row: asyncpg.Record) -> str:
    """Return the ideal schema UUID for a property row, preserving valid UUIDs."""
    existing = row.get("uuid")
    if _is_valid_uuid(existing):
        return str(existing)
    return uuidv7()


def _value_uuid(row: asyncpg.Record) -> str:
    """Return the ideal value UUID for a value row, preserving valid UUIDs."""
    existing = row.get("uuid")
    if _is_valid_uuid(existing):
        return str(existing)
    return uuidv7()


def _map_property_type(prop_type: str, is_multi: bool) -> tuple[str, dict[str, Any]]:
    """Map a legacy property type to an ideal type and base config."""
    ideal_type = PROPERTY_TYPE_MAP.get(prop_type, "text")
    config: dict[str, Any] = {}

    # The ideal schema distinguishes multi-select from single-select.
    if ideal_type == "select" and is_multi:
        ideal_type = "multi_select"

    # Preserve the legacy multi flag for non-select types that support it
    # (e.g. multi-relation node properties).
    if is_multi and ideal_type != "multi_select":
        config["multi"] = True

    # url/email become text with a config hint so the UI can render them.
    if prop_type in ("url", "email"):
        config["format"] = prop_type

    return ideal_type, config


async def fetch_properties(
    conn: asyncpg.Connection,
    workspace_int_id: int,
) -> list[asyncpg.Record]:
    """Fetch active property rows for a workspace."""
    query = """
        SELECT id, uuid, name, icon, type, is_multi, is_system, scope, node_id,
               icon_visibility
        FROM property
        WHERE workspace_id = $1 AND active = TRUE
        ORDER BY id
    """
    return await conn.fetch(query, workspace_int_id)


async def fetch_property_selection_lines(
    conn: asyncpg.Connection,
    property_int_ids: list[int],
) -> list[asyncpg.Record]:
    """Fetch selection-line options for the given property integer ids."""
    if not property_int_ids:
        return []
    query = """
        SELECT id, uuid, property_id, name, icon, sequence
        FROM property_selection_line
        WHERE property_id = ANY($1::int[])
        ORDER BY property_id, sequence, id
    """
    return await conn.fetch(query, property_int_ids)


async def fetch_node_properties(
    conn: asyncpg.Connection,
    workspace_int_id: int,
) -> list[asyncpg.Record]:
    """Fetch node_property assignments for a workspace."""
    query = """
        SELECT np.id, np.uuid, np.node_id, np.property_id
        FROM node_property np
        JOIN node n ON np.node_id = n.id
        WHERE n.workspace_id = $1
        ORDER BY np.id
    """
    return await conn.fetch(query, workspace_int_id)


async def fetch_class_properties(
    conn: asyncpg.Connection,
    workspace_int_id: int,
) -> list[asyncpg.Record]:
    """Fetch class_property bindings for a workspace."""
    query = """
        SELECT cp.id, cp.uuid, cp.class_node_id, cp.property_id, cp.sequence,
               cp.hidden, cp.required, cp.readonly, cp.hide_when_empty
        FROM class_property cp
        JOIN node n ON cp.class_node_id = n.id
        WHERE n.workspace_id = $1
        ORDER BY cp.class_node_id, cp.sequence, cp.id
    """
    return await conn.fetch(query, workspace_int_id)


async def fetch_class_extends(
    conn: asyncpg.Connection,
    workspace_int_id: int,
) -> list[asyncpg.Record]:
    """Fetch class inheritance relationships for a workspace."""
    query = """
        SELECT ce.id, ce.uuid, ce.target_id, ce.source_id, ce.sequence
        FROM class_extend ce
        JOIN node n ON ce.target_id = n.id
        WHERE n.workspace_id = $1
        ORDER BY ce.target_id, ce.sequence, ce.id
    """
    return await conn.fetch(query, workspace_int_id)


async def fetch_class_node_names(
    conn: asyncpg.Connection,
    class_int_ids: list[int],
) -> dict[int, str]:
    """Fetch names for class nodes."""
    if not class_int_ids:
        return {}
    query = """
        SELECT id, name
        FROM node
        WHERE id = ANY($1::int[])
    """
    rows = await conn.fetch(query, class_int_ids)
    return {row["id"]: row["name"] or "" for row in rows}


async def fetch_scalar_values(
    conn: asyncpg.Connection,
    workspace_int_id: int,
) -> list[asyncpg.Record]:
    """Fetch scalar property values for live nodes in a workspace."""
    query = """
        SELECT pvs.id, pvs.uuid, pvs.node_property_id, pvs.property_id,
               pvs.node_id, pvs.value_text, pvs.value_boolean, pvs.value_float,
               pvs.value_integer
        FROM property_value_scalar pvs
        JOIN node n ON pvs.node_id = n.id
        WHERE n.workspace_id = $1 AND n.is_deleted = FALSE
        ORDER BY pvs.id
    """
    return await conn.fetch(query, workspace_int_id)


async def fetch_relation_values(
    conn: asyncpg.Connection,
    workspace_int_id: int,
) -> list[asyncpg.Record]:
    """Fetch relation property values for live nodes in a workspace."""
    query = """
        SELECT pvr.id, pvr.uuid, pvr.node_property_id, pvr.property_id,
               pvr.node_id, pvr.target_id, pvr.order
        FROM property_value_relation pvr
        JOIN node n ON pvr.node_id = n.id
        WHERE n.workspace_id = $1 AND n.is_deleted = FALSE
        ORDER BY pvr.id
    """
    return await conn.fetch(query, workspace_int_id)


async def fetch_selection_values(
    conn: asyncpg.Connection,
    workspace_int_id: int,
) -> list[asyncpg.Record]:
    """Fetch selection property values for live nodes in a workspace."""
    query = """
        SELECT pvsel.id, pvsel.uuid, pvsel.node_property_id, pvsel.property_id,
               pvsel.node_id, pvsel.selection_line_id
        FROM property_value_selection pvsel
        JOIN node n ON pvsel.node_id = n.id
        WHERE n.workspace_id = $1 AND n.is_deleted = FALSE
        ORDER BY pvsel.id
    """
    return await conn.fetch(query, workspace_int_id)


def _build_schema_id_map(
    properties: list[asyncpg.Record],
) -> dict[int, str]:
    """Map every legacy property id to a stable ideal schema UUID."""
    id_map: dict[int, str] = {}
    for row in properties:
        id_map[row["id"]] = _schema_uuid(row)
    return id_map


def _build_selection_line_id_map(
    selection_lines: list[asyncpg.Record],
) -> dict[int, str]:
    """Map every legacy selection line id to a stable ideal option UUID."""
    id_map: dict[int, str] = {}
    for row in selection_lines:
        existing = row.get("uuid")
        if _is_valid_uuid(existing):
            id_map[row["id"]] = str(existing)
        else:
            id_map[row["id"]] = uuidv7()
    return id_map


def _property_schema_create_ops(
    ctx: MigrationContext,
    properties: list[asyncpg.Record],
    selection_lines: list[asyncpg.Record],
    schema_id_map: dict[int, str],
    line_id_map: dict[int, str],
) -> list[Operation]:
    """Emit ``propertySchema.create`` operations for all properties."""
    options_by_property: dict[int, list[dict[str, Any]]] = {}
    for line in selection_lines:
        option: dict[str, Any] = {
            "id": line_id_map[line["id"]],
            "name": line["name"],
            "sequence": line.get("sequence", 0),
        }
        icon = line.get("icon")
        if icon:
            option["icon"] = icon
        options_by_property.setdefault(line["property_id"], []).append(option)

    ops: list[Operation] = []
    for row in properties:
        prop_id = row["id"]
        schema_id = schema_id_map[prop_id]
        ideal_type, config = _map_property_type(
            row["type"], bool(row.get("is_multi", False))
        )
        if prop_id in options_by_property:
            config["options"] = options_by_property[prop_id]

        ops.append(
            create_operation(
                envelope={
                    "workspace_id": ctx.workspace_uuid,
                    "actor_id": ctx.actor_id,
                    "hlc": ctx.next_hlc(),
                    "affected_node_ids": [],
                    "op_type": "propertySchema.create",
                },
                payload={
                    "schemaId": schema_id,
                    "name": row["name"],
                    "type": ideal_type,
                    "config": config,
                },
            )
        )
    return ops


def _extract_scalar_value(row: asyncpg.Record, prop_type: str) -> Any:
    """Extract the scalar value from a property_value_scalar row."""
    if prop_type in ("text", "url", "email", "date"):
        return row.get("value_text")

    if prop_type == "integer":
        return row.get("value_integer")

    if prop_type == "float":
        return row.get("value_float")

    if prop_type == "boolean":
        return row.get("value_boolean")

    if prop_type == "date_range":
        text = row.get("value_text")
        if text is None:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    return row.get("value_text")


def _property_set_ops(
    ctx: MigrationContext,
    scalar_values: list[asyncpg.Record],
    relation_values: list[asyncpg.Record],
    selection_values: list[asyncpg.Record],
    properties: list[asyncpg.Record],
    schema_id_map: dict[int, str],
    line_id_map: dict[int, str],
    node_property_assignments: set[tuple[int, int]],
) -> list[Operation]:
    """Emit ``property.set`` operations for all value rows."""
    prop_type_by_id = {row["id"]: row["type"] for row in properties}
    ops: list[Operation] = []

    def _add(node_id_int: int, prop_id: int, index: int, value: Any, row: asyncpg.Record) -> None:
        if (node_id_int, prop_id) not in node_property_assignments:
            return
        node_uuid = ctx.map_node_id(node_id_int)
        schema_uuid = schema_id_map.get(prop_id)
        if node_uuid is None or schema_uuid is None or value is None:
            return
        ops.append(
            create_operation(
                envelope={
                    "workspace_id": ctx.workspace_uuid,
                    "actor_id": ctx.actor_id,
                    "hlc": ctx.next_hlc(),
                    "affected_node_ids": [node_uuid],
                    "op_type": "property.set",
                },
                payload={
                    "propertyValueId": _value_uuid(row),
                    "nodeId": node_uuid,
                    "schemaId": schema_uuid,
                    "index": index,
                    "value": {"value": value},
                },
            )
        )

    for row in scalar_values:
        prop_id = row["property_id"]
        prop_type = prop_type_by_id.get(prop_id, "text")
        value = _extract_scalar_value(row, prop_type)
        _add(row["node_id"], prop_id, 0, value, row)

    for row in relation_values:
        target_uuid = ctx.map_node_id(row["target_id"])
        _add(
            row["node_id"],
            row["property_id"],
            row.get("order") or 0,
            target_uuid,
            row,
        )

    # Selection values have no order column; enumerate per (node, property)
    # so multi-select options get distinct indices.
    selection_groups: dict[tuple[int, int], list[asyncpg.Record]] = {}
    for row in selection_values:
        key = (row["node_id"], row["property_id"])
        selection_groups.setdefault(key, []).append(row)

    for (node_id_int, prop_id), rows in selection_groups.items():
        for index, row in enumerate(rows):
            line_uuid = line_id_map.get(row["selection_line_id"])
            _add(node_id_int, prop_id, index, line_uuid, row)

    return ops


def _class_create_ops(
    ctx: MigrationContext,
    class_properties: list[asyncpg.Record],
    class_extends: list[asyncpg.Record],
    class_node_names: dict[int, str],
    schema_id_map: dict[int, str],
) -> list[Operation]:
    """Emit ``class.create`` operations for class nodes."""
    schemas_by_class: dict[int, list[str]] = {}
    for row in class_properties:
        class_id = row["class_node_id"]
        schema_uuid = schema_id_map.get(row["property_id"])
        if schema_uuid is None:
            continue
        schemas_by_class.setdefault(class_id, []).append(schema_uuid)

    extends_by_class: dict[int, list[str]] = {}
    for row in class_extends:
        target_id = row["target_id"]
        source_uuid = ctx.map_node_id(row["source_id"])
        if source_uuid is None:
            continue
        extends_by_class.setdefault(target_id, []).append(source_uuid)

    class_ids = sorted(set(schemas_by_class.keys()) | set(extends_by_class.keys()))

    ops: list[Operation] = []
    for class_id in class_ids:
        class_uuid = ctx.map_node_id(class_id)
        if class_uuid is None:
            continue
        ops.append(
            create_operation(
                envelope={
                    "workspace_id": ctx.workspace_uuid,
                    "actor_id": ctx.actor_id,
                    "hlc": ctx.next_hlc(),
                    "affected_node_ids": [class_uuid],
                    "op_type": "class.create",
                },
                payload={
                    "classId": class_uuid,
                    "name": class_node_names.get(class_id, ""),
                    "propertySchemaIds": schemas_by_class.get(class_id, []),
                    "extends": extends_by_class.get(class_id, []),
                },
            )
        )
    return ops


async def migrate_properties_for_workspace(
    conn: asyncpg.Connection,
    workspace_int_id: int,
    ctx: MigrationContext,
) -> list[Operation]:
    """Migrate one workspace's properties and classes into ideal operations.

    Args:
        conn: Asyncpg connection to the source PostgreSQL database.
        workspace_int_id: Legacy integer id of the workspace to migrate.
        ctx: Shared migration context (from node migration) providing HLC clock
            and node id mapping.

    Returns:
        List of generated operations in dependency order: property schemas,
        property values, then class metadata.
    """
    properties = await fetch_properties(conn, workspace_int_id)
    property_ids = [row["id"] for row in properties]
    selection_lines = await fetch_property_selection_lines(conn, property_ids)

    schema_id_map = _build_schema_id_map(properties)
    line_id_map = _build_selection_line_id_map(selection_lines)

    node_properties = await fetch_node_properties(conn, workspace_int_id)
    node_property_assignments = {
        (row["node_id"], row["property_id"]) for row in node_properties
    }

    scalar_values = await fetch_scalar_values(conn, workspace_int_id)
    relation_values = await fetch_relation_values(conn, workspace_int_id)
    selection_values = await fetch_selection_values(conn, workspace_int_id)

    class_properties = await fetch_class_properties(conn, workspace_int_id)
    class_extends = await fetch_class_extends(conn, workspace_int_id)
    class_ids = sorted(
        {row["class_node_id"] for row in class_properties}
        | {row["target_id"] for row in class_extends}
    )
    class_node_names = await fetch_class_node_names(conn, class_ids)

    operations: list[Operation] = []
    operations.extend(
        _property_schema_create_ops(
            ctx, properties, selection_lines, schema_id_map, line_id_map
        )
    )
    operations.extend(
        _property_set_ops(
            ctx,
            scalar_values,
            relation_values,
            selection_values,
            properties,
            schema_id_map,
            line_id_map,
            node_property_assignments,
        )
    )
    operations.extend(
        _class_create_ops(
            ctx, class_properties, class_extends, class_node_names, schema_id_map
        )
    )

    return operations
