"""Workspace import/export and restore functionality.

Provides:
- Full workspace export (comprehensive dump with all data)
- Import dump to new workspace (with UUID remapping)
- Restore workspace from dump file (keeping original UUIDs)
"""

from __future__ import annotations

import json
import re
import shutil
import uuid as uuid_module
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import asyncpg

from .db.connection import get_connection, get_data_dir
from .domain.stringify_ast import StringifyMode, StringifyOptions, parse_ast, stringify_ast
from .logging_config import get_logger
from .workspace_manager import _active_workspaces, _get_numeric_user_id

logger = get_logger(__name__)

# UUID regex for finding UUIDs in text
UUID_PATTERN = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def _parse_datetime(value: Any) -> datetime | None:
    """Parse a datetime from various formats."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            try:
                return datetime.strptime(value, "%Y-%m-%d %H:%M:%S.%f%z")
            except ValueError:
                try:
                    return datetime.strptime(value, "%Y-%m-%d %H:%M:%S%z")
                except ValueError:
                    logger.warning(f"Could not parse datetime: {value}")
                    return datetime.now(UTC)
    return None


def _to_bool(value: Any) -> bool | None:
    """Convert value to bool."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in ("true", "1", "yes")
    return bool(value)


def _to_int(value: Any) -> int | None:
    """Convert value to int."""
    if value is None:
        return None
    return int(value)


def _remap_uuids_in_text(text: str, uuid_map: dict[str, str]) -> str:
    """Replace all mapped UUIDs in a text string."""
    if not text or not uuid_map:
        return text

    def replace_uuid(match: re.Match[str]) -> str:
        old_uuid = match.group(0).lower()
        return uuid_map.get(old_uuid, match.group(0))

    return UUID_PATTERN.sub(replace_uuid, text)


def _remap_uuids_in_jsonb(data: Any, uuid_map: dict[str, str]) -> Any:
    """Replace all mapped UUIDs in a JSONB value."""
    if data is None or not uuid_map:
        return data
    text = json.dumps(data, default=str)
    text = _remap_uuids_in_text(text, uuid_map)
    return json.loads(text)


def _ensure_list(value: Any) -> list:
    """Ensure a value is a list, parsing JSON strings if needed."""
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return parsed
        except (json.JSONDecodeError, TypeError):
            pass
    return [] if value is None else []


def _remap_int_list(values: Any, id_map: dict[int, int]) -> list[int]:
    """Remap a list of integer IDs using a mapping."""
    if not values:
        return []
    result = []
    for v in values:
        if isinstance(v, int):
            mapped = id_map.get(v)
            if mapped is not None:
                result.append(mapped)
        elif isinstance(v, str) and v.isdigit():
            mapped = id_map.get(int(v))
            if mapped is not None:
                result.append(mapped)
    return result


# ============================================================
# EXPORT
# ============================================================


async def export_workspace_full(
    conn: asyncpg.Connection,
    workspace_id: int,
) -> dict:
    """Create a comprehensive dump of all workspace data.

    Includes all tables related to the workspace with integer IDs
    for reference resolution during import.

    Args:
        conn: Database connection
        workspace_id: Workspace integer ID

    Returns:
        Dict with all workspace data (JSON-serializable)
    """
    workspace = await conn.fetchrow("SELECT uuid, name FROM workspace WHERE id = $1", workspace_id)
    if not workspace:
        raise ValueError(f"Workspace {workspace_id} not found")

    # Nodes (including integer id for FK resolution)
    nodes = await conn.fetch(
        """
        SELECT id, uuid, name, icon, color, parent_id, page_id, sequence,
               collapsed, active, version, is_class, is_page, is_day,
               is_month, is_year, is_asset, is_template, is_comment,
               class_ids, classes_path, open_date, create_date, write_date,
               aliased_id, is_deleted, deleted_at
        FROM node WHERE workspace_id = $1
    """,
        workspace_id,
    )

    # Node links
    links = await conn.fetch(
        """
        SELECT id, uuid, source_id, target_id, property_id, position,
               is_tag, is_inline_class, name, create_date
        FROM node_link WHERE workspace_id = $1
    """,
        workspace_id,
    )

    # Properties
    properties = await conn.fetch(
        """
        SELECT id, uuid, name, icon, type, is_multi, is_system, is_local,
               node_id, icon_visibility, active, create_date, write_date
        FROM property WHERE workspace_id = $1
    """,
        workspace_id,
    )

    # Property selection lines
    selection_lines = await conn.fetch(
        """
        SELECT psl.id, psl.uuid, psl.property_id, psl.name, psl.icon,
               psl.create_date, psl.write_date
        FROM property_selection_line psl
        JOIN property p ON psl.property_id = p.id
        WHERE p.workspace_id = $1
    """,
        workspace_id,
    )

    # Node properties
    node_properties = await conn.fetch(
        """
        SELECT np.id, np.uuid, np.node_id, np.property_id,
               np.create_date, np.write_date
        FROM node_property np
        JOIN node n ON np.node_id = n.id
        WHERE n.workspace_id = $1
    """,
        workspace_id,
    )

    # Property value scalars
    value_scalars = await conn.fetch(
        """
        SELECT pvs.id, pvs.uuid, pvs.node_property_id, pvs.property_id,
               pvs.node_id, pvs.value_text, pvs.value_boolean,
               pvs.value_float, pvs.value_integer,
               pvs.create_date, pvs.write_date
        FROM property_value_scalar pvs
        JOIN node n ON pvs.node_id = n.id
        WHERE n.workspace_id = $1
    """,
        workspace_id,
    )

    # Property value relations
    value_relations = await conn.fetch(
        """
        SELECT pvr.id, pvr.uuid, pvr.node_property_id, pvr.property_id,
               pvr.node_id, pvr.target_id, pvr."order",
               pvr.create_date, pvr.write_date
        FROM property_value_relation pvr
        JOIN node n ON pvr.node_id = n.id
        WHERE n.workspace_id = $1
    """,
        workspace_id,
    )

    # Property value selections
    value_selections = await conn.fetch(
        """
        SELECT pvsel.id, pvsel.uuid, pvsel.node_property_id,
               pvsel.property_id, pvsel.node_id, pvsel.selection_line_id,
               pvsel.create_date, pvsel.write_date
        FROM property_value_selection pvsel
        JOIN node n ON pvsel.node_id = n.id
        WHERE n.workspace_id = $1
    """,
        workspace_id,
    )

    # Class properties
    class_properties = await conn.fetch(
        """
        SELECT cp.id, cp.class_node_id, cp.property_id, cp.sequence,
               cp.hidden, cp.default_integer, cp.default_float,
               cp.default_text, cp.default_boolean,
               cp.default_node_id, cp.default_selection_id
        FROM class_property cp
        JOIN node n ON cp.class_node_id = n.id
        WHERE n.workspace_id = $1
    """,
        workspace_id,
    )

    # Class extends
    class_extends = await conn.fetch(
        """
        SELECT ce.id, ce.target_id, ce.source_id, ce.sequence
        FROM class_extend ce
        JOIN node n ON ce.target_id = n.id
        WHERE n.workspace_id = $1
    """,
        workspace_id,
    )

    # Property class filters
    class_filters = await conn.fetch(
        """
        SELECT pcf.id, pcf.property_id, pcf.class_node_id
        FROM property_class_filter pcf
        JOIN property p ON pcf.property_id = p.id
        WHERE p.workspace_id = $1
    """,
        workspace_id,
    )

    # Node views
    node_views = await conn.fetch(
        """
        SELECT nv.id, nv.uuid, nv.node_id, nv.name, nv.query_json,
               nv.view_type, nv.order_index, nv.is_default, nv.active,
               nv.shown_properties, nv.group_by,
               nv.create_date, nv.write_date
        FROM node_view nv
        JOIN node n ON nv.node_id = n.id
        WHERE n.workspace_id = $1
    """,
        workspace_id,
    )

    # Workspace settings
    settings = await conn.fetch(
        "SELECT key, value FROM setting_workspace WHERE workspace_id = $1",
        workspace_id,
    )

    return {
        "version": 3,
        "workspace": {
            "uuid": str(workspace["uuid"]),
            "name": workspace["name"],
        },
        "nodes": [dict(r) for r in nodes],
        "links": [dict(r) for r in links],
        "properties": [dict(r) for r in properties],
        "property_selection_lines": [dict(r) for r in selection_lines],
        "node_properties": [dict(r) for r in node_properties],
        "property_value_scalars": [dict(r) for r in value_scalars],
        "property_value_relations": [dict(r) for r in value_relations],
        "property_value_selections": [dict(r) for r in value_selections],
        "class_properties": [dict(r) for r in class_properties],
        "class_extends": [dict(r) for r in class_extends],
        "property_class_filters": [dict(r) for r in class_filters],
        "node_views": [dict(r) for r in node_views],
        "settings": [dict(r) for r in settings],
    }


# ============================================================
# CORE IMPORT LOGIC
# ============================================================


async def _import_dump_core(
    conn: asyncpg.Connection,
    dump_data: dict,
    workspace_id: int,
    user_id: int,
    remap_uuids: bool = False,
) -> dict[str, Any]:
    """Core import logic shared between import-to-new and restore.

    Inserts all dump data into the target workspace, handling FK resolution
    via integer ID mapping.

    Args:
        conn: Database connection (should be within a transaction)
        dump_data: Parsed dump data (v2 or v3 format)
        workspace_id: Target workspace integer ID
        user_id: User ID for audit fields
        remap_uuids: If True, generate new UUIDs for all entities

    Returns:
        Dict with import statistics
    """
    now = datetime.now(UTC)

    # ── Build UUID mapping ──────────────────────────────────
    uuid_map: dict[str, str] = {}  # old_uuid_lower -> new_uuid

    if remap_uuids:
        # Collect all UUIDs from every entity type
        for node in dump_data.get("nodes", []):
            old = str(node["uuid"]).lower()
            uuid_map[old] = str(uuid_module.uuid4())

        for link in dump_data.get("links", []):
            old = str(link["uuid"]).lower()
            uuid_map[old] = str(uuid_module.uuid4())

        for prop in dump_data.get("properties", []):
            old = str(prop["uuid"]).lower()
            uuid_map[old] = str(uuid_module.uuid4())

        for sl in dump_data.get("property_selection_lines", []):
            if "uuid" in sl:
                old = str(sl["uuid"]).lower()
                uuid_map[old] = str(uuid_module.uuid4())

        for np in dump_data.get("node_properties", []):
            if "uuid" in np:
                old = str(np["uuid"]).lower()
                uuid_map[old] = str(uuid_module.uuid4())

        for vs in dump_data.get("property_value_scalars", []):
            if "uuid" in vs:
                old = str(vs["uuid"]).lower()
                uuid_map[old] = str(uuid_module.uuid4())

        for vr in dump_data.get("property_value_relations", []):
            if "uuid" in vr:
                old = str(vr["uuid"]).lower()
                uuid_map[old] = str(uuid_module.uuid4())

        for vsel in dump_data.get("property_value_selections", []):
            if "uuid" in vsel:
                old = str(vsel["uuid"]).lower()
                uuid_map[old] = str(uuid_module.uuid4())

        for nv in dump_data.get("node_views", []):
            if "uuid" in nv:
                old = str(nv["uuid"]).lower()
                uuid_map[old] = str(uuid_module.uuid4())

        # Also remap the workspace UUID itself
        ws_uuid = str(dump_data.get("workspace", {}).get("uuid", "")).lower()
        if ws_uuid:
            uuid_map[ws_uuid] = str(uuid_module.uuid4())

        logger.info(f"UUID remap: {len(uuid_map)} UUIDs will be remapped")

    def map_uuid(old_val: Any) -> str:
        """Map an old UUID to its new value (or keep if no remap)."""
        if old_val is None:
            return str(uuid_module.uuid4())
        s = str(old_val).lower()
        return uuid_map.get(s, str(old_val))

    # ── Integer ID maps ─────────────────────────────────────
    node_id_map: dict[int, int] = {}
    property_id_map: dict[int, int] = {}
    selection_line_id_map: dict[int, int] = {}
    node_property_id_map: dict[int, int] = {}

    stats = {
        "nodes": 0,
        "links": 0,
        "properties": 0,
        "property_selection_lines": 0,
        "node_properties": 0,
        "property_values": 0,
        "class_properties": 0,
        "class_extends": 0,
        "property_class_filters": 0,
        "node_views": 0,
        "settings": 0,
    }

    # ── Disable triggers for bulk import performance ───────
    # These triggers fire per-row and cause timeouts on large imports.
    # We rebuild node_path and search vectors at the end instead.
    logger.info("Disabling node triggers for bulk import")
    await conn.execute("ALTER TABLE node DISABLE TRIGGER node_search_update")
    await conn.execute("ALTER TABLE node DISABLE TRIGGER node_path_after_insert")
    await conn.execute("ALTER TABLE node DISABLE TRIGGER node_path_after_update")
    await conn.execute("ALTER TABLE node DISABLE TRIGGER node_path_before_delete")
    await conn.execute("ALTER TABLE node DISABLE TRIGGER node_write_date")
    await conn.execute("ALTER TABLE node DISABLE TRIGGER node_update_workspace_write_date")
    # Disable version capture trigger if it exists
    await conn.execute("""
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_node_version_capture') THEN
                ALTER TABLE node DISABLE TRIGGER trg_node_version_capture;
            END IF;
        END $$;
    """)

    # ── Phase 1: Batch insert nodes ─────────────────────────
    nodes_data = dump_data.get("nodes", [])
    logger.info(f"Importing {len(nodes_data)} nodes (phase 1: batch insert)")

    node_records = []
    node_uuid_to_old_id: dict[str, int] = {}

    for node_data in nodes_data:
        old_id = node_data.get("id")
        if old_id is None:
            continue

        node_uuid = map_uuid(node_data.get("uuid"))
        node_name = str(node_data.get("name", ""))
        if remap_uuids:
            node_name = _remap_uuids_in_text(node_name, uuid_map)

        node_uuid_to_old_id[node_uuid.lower()] = old_id
        node_records.append(
            (
                node_uuid,
                workspace_id,
                node_name,
                node_data.get("icon"),
                node_data.get("color"),
                _to_int(node_data.get("sequence", 0)),
                _to_bool(node_data.get("collapsed", False)),
                _to_bool(node_data.get("active", True)),
                _to_int(node_data.get("version", 1)),
                _to_bool(node_data.get("is_class", False)),
                _to_bool(node_data.get("is_page", False)),
                _to_bool(node_data.get("is_day", False)),
                _to_bool(node_data.get("is_month", False)),
                _to_bool(node_data.get("is_year", False)),
                _to_bool(node_data.get("is_asset", False)),
                _to_bool(node_data.get("is_template", False)),
                _to_bool(node_data.get("is_comment", False)),
                json.dumps(_ensure_list(node_data.get("classes_path", []))),
                _parse_datetime(node_data.get("open_date")),
                _parse_datetime(node_data.get("create_date")) or now,
                _parse_datetime(node_data.get("write_date")) or now,
                _to_bool(node_data.get("is_deleted", False)),
                _parse_datetime(node_data.get("deleted_at")),
                user_id,
            )
        )

    if node_records:
        await conn.executemany(
            """
            INSERT INTO node (
                uuid, workspace_id, name, icon, color,
                sequence, collapsed, active, version,
                is_class, is_page, is_day, is_month, is_year,
                is_asset, is_template, is_comment,
                classes_path, open_date, create_date, write_date,
                is_deleted, deleted_at,
                create_uid, write_uid
            ) VALUES (
                $1::uuid, $2, $3, $4, $5,
                $6, $7, $8, $9,
                $10, $11, $12, $13, $14,
                $15, $16, $17,
                $18::jsonb, $19, $20, $21,
                $22, $23,
                $24, $24
            )
        """,
            node_records,
            timeout=None,
        )

        # Batch fetch ID mappings
        rows = await conn.fetch(
            "SELECT id, uuid::text AS uuid_str FROM node WHERE workspace_id = $1",
            workspace_id,
        )
        for row in rows:
            old_id = node_uuid_to_old_id.get(row["uuid_str"])
            if old_id is not None:
                node_id_map[old_id] = row["id"]

    stats["nodes"] = len(node_id_map)

    # ── Phase 2: Batch update node references ───────────────
    logger.info("Importing nodes (phase 2: batch update references)")

    update_records = []
    for node_data in nodes_data:
        old_id = node_data.get("id")
        if old_id is None or old_id not in node_id_map:
            continue

        new_id = node_id_map[old_id]
        parent_id = node_id_map.get(int(node_data["parent_id"])) if node_data.get("parent_id") is not None else None
        page_id = node_id_map.get(int(node_data["page_id"])) if node_data.get("page_id") is not None else None
        aliased_id = node_id_map.get(int(node_data["aliased_id"])) if node_data.get("aliased_id") is not None else None
        class_ids = _remap_int_list(node_data.get("class_ids", []), node_id_map)
        classes_path = node_data.get("classes_path", [])
        if isinstance(classes_path, list):
            classes_path = _remap_int_list(classes_path, node_id_map)

        if parent_id or page_id or aliased_id or class_ids:
            update_records.append(
                (
                    parent_id,
                    page_id,
                    aliased_id,
                    class_ids if class_ids else [],
                    json.dumps(_ensure_list(classes_path)),
                    new_id,
                )
            )

    if update_records:
        await conn.executemany(
            """
            UPDATE node
            SET parent_id = $1, page_id = $2, aliased_id = $3,
                class_ids = $4, classes_path = $5::jsonb
            WHERE id = $6
        """,
            update_records,
            timeout=None,
        )

    # ── Phase 3: Batch insert properties ────────────────────
    properties_data = dump_data.get("properties", [])
    logger.info(f"Importing {len(properties_data)} properties")

    prop_records = []
    prop_uuid_to_old_id: dict[str, int] = {}

    for prop_data in properties_data:
        old_id = prop_data.get("id")
        if old_id is None:
            continue

        prop_uuid = map_uuid(prop_data.get("uuid"))
        prop_node_id = None
        if prop_data.get("node_id") is not None:
            prop_node_id = node_id_map.get(int(prop_data["node_id"]))

        prop_uuid_to_old_id[prop_uuid.lower()] = old_id
        prop_records.append(
            (
                prop_uuid,
                workspace_id,
                str(prop_data.get("name", "")),
                prop_data.get("icon"),
                str(prop_data.get("type", "text")),
                _to_bool(prop_data.get("is_multi", False)),
                _to_bool(prop_data.get("is_system", False)),
                _to_bool(prop_data.get("is_local", False)),
                prop_node_id,
                prop_data.get("icon_visibility", "hidden"),
                _to_bool(prop_data.get("active", True)),
                _parse_datetime(prop_data.get("create_date")) or now,
                _parse_datetime(prop_data.get("write_date")) or now,
                user_id,
            )
        )

    if prop_records:
        await conn.executemany(
            """
            INSERT INTO property (
                uuid, workspace_id, name, icon, type, is_multi, is_system,
                is_local, node_id, icon_visibility, active,
                create_date, write_date, create_uid, write_uid
            ) VALUES (
                $1::uuid, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11,
                $12, $13, $14, $14
            )
        """,
            prop_records,
            timeout=None,
        )

        rows = await conn.fetch(
            "SELECT id, uuid::text AS uuid_str FROM property WHERE workspace_id = $1",
            workspace_id,
        )
        for row in rows:
            old_id = prop_uuid_to_old_id.get(row["uuid_str"])
            if old_id is not None:
                property_id_map[old_id] = row["id"]

    stats["properties"] = len(property_id_map)

    # ── Phase 4: Batch insert property selection lines ──────
    sel_lines_data = dump_data.get("property_selection_lines", [])
    logger.info(f"Importing {len(sel_lines_data)} property selection lines")

    sl_records = []
    sl_uuid_to_old_id: dict[str, int] = {}

    for sl_data in sel_lines_data:
        old_id = sl_data.get("id")
        if old_id is None:
            continue

        prop_id = property_id_map.get(int(sl_data["property_id"]))
        if prop_id is None:
            logger.warning(f"Skipping selection line {old_id}: property {sl_data['property_id']} not found in map")
            continue

        sl_uuid = map_uuid(sl_data.get("uuid"))
        sl_uuid_to_old_id[sl_uuid.lower()] = old_id
        sl_records.append(
            (
                sl_uuid,
                prop_id,
                str(sl_data.get("name", "")),
                sl_data.get("icon"),
                _parse_datetime(sl_data.get("create_date")) or now,
                _parse_datetime(sl_data.get("write_date")) or now,
                user_id,
            )
        )

    if sl_records:
        await conn.executemany(
            """
            INSERT INTO property_selection_line (
                uuid, property_id, name, icon, create_date, write_date,
                create_uid, write_uid
            ) VALUES (
                $1::uuid, $2, $3, $4, $5, $6, $7, $7
            )
        """,
            sl_records,
            timeout=None,
        )

        rows = await conn.fetch(
            """
            SELECT psl.id, psl.uuid::text AS uuid_str
            FROM property_selection_line psl
            JOIN property p ON psl.property_id = p.id
            WHERE p.workspace_id = $1
        """,
            workspace_id,
        )
        for row in rows:
            old_id = sl_uuid_to_old_id.get(row["uuid_str"])
            if old_id is not None:
                selection_line_id_map[old_id] = row["id"]

    stats["property_selection_lines"] = len(selection_line_id_map)

    # ── Phase 5: Batch insert property class filters ────────
    pcf_data = dump_data.get("property_class_filters", [])
    logger.info(f"Importing {len(pcf_data)} property class filters")

    pcf_records = []
    for pcf in pcf_data:
        prop_id = property_id_map.get(int(pcf["property_id"]))
        class_node_id = node_id_map.get(int(pcf["class_node_id"]))

        if prop_id is None or class_node_id is None:
            logger.warning(
                f"Skipping property class filter: "
                f"property {pcf['property_id']} or class {pcf['class_node_id']} not found"
            )
            continue

        pcf_records.append((prop_id, class_node_id))

    if pcf_records:
        await conn.executemany(
            """
            INSERT INTO property_class_filter (property_id, class_node_id)
            VALUES ($1, $2)
            ON CONFLICT (property_id, class_node_id) DO NOTHING
        """,
            pcf_records,
            timeout=None,
        )

    stats["property_class_filters"] = len(pcf_records)

    # ── Phase 6: Batch insert node properties ───────────────
    np_data = dump_data.get("node_properties", [])
    logger.info(f"Importing {len(np_data)} node properties")

    np_records = []
    np_uuid_to_old_id: dict[str, int] = {}

    for np_item in np_data:
        old_id = np_item.get("id")
        if old_id is None:
            continue

        n_id = node_id_map.get(int(np_item["node_id"]))
        p_id = property_id_map.get(int(np_item["property_id"]))

        if n_id is None or p_id is None:
            logger.warning(
                f"Skipping node_property {old_id}: "
                f"node {np_item['node_id']} or property {np_item['property_id']} not found"
            )
            continue

        np_uuid = map_uuid(np_item.get("uuid"))
        np_uuid_to_old_id[np_uuid.lower()] = old_id
        np_records.append(
            (
                np_uuid,
                n_id,
                p_id,
                _parse_datetime(np_item.get("create_date")) or now,
                _parse_datetime(np_item.get("write_date")) or now,
                user_id,
            )
        )

    if np_records:
        await conn.executemany(
            """
            INSERT INTO node_property (
                uuid, node_id, property_id, create_date, write_date,
                create_uid, write_uid
            ) VALUES (
                $1::uuid, $2, $3, $4, $5, $6, $6
            )
        """,
            np_records,
            timeout=None,
        )

        rows = await conn.fetch(
            """
            SELECT np.id, np.uuid::text AS uuid_str
            FROM node_property np
            JOIN node n ON np.node_id = n.id
            WHERE n.workspace_id = $1
        """,
            workspace_id,
        )
        for row in rows:
            old_id = np_uuid_to_old_id.get(row["uuid_str"])
            if old_id is not None:
                node_property_id_map[old_id] = row["id"]

    stats["node_properties"] = len(node_property_id_map)

    # ── Phase 7: Batch insert property value scalars ────────
    pvs_data = dump_data.get("property_value_scalars", [])
    logger.info(f"Importing {len(pvs_data)} property value scalars")

    pvs_records = []
    for pvs in pvs_data:
        np_id = node_property_id_map.get(int(pvs["node_property_id"]))
        p_id = property_id_map.get(int(pvs["property_id"]))
        n_id = node_id_map.get(int(pvs["node_id"]))

        if np_id is None or p_id is None or n_id is None:
            logger.warning("Skipping property_value_scalar: missing FK mapping")
            continue

        pvs_uuid = map_uuid(pvs.get("uuid"))
        value_text = pvs.get("value_text")
        if remap_uuids and value_text:
            value_text = _remap_uuids_in_text(str(value_text), uuid_map)

        pvs_records.append(
            (
                pvs_uuid,
                np_id,
                p_id,
                n_id,
                value_text,
                _to_bool(pvs.get("value_boolean")),
                float(pvs["value_float"]) if pvs.get("value_float") is not None else None,
                _to_int(pvs.get("value_integer")),
                _parse_datetime(pvs.get("create_date")) or now,
                _parse_datetime(pvs.get("write_date")) or now,
                user_id,
            )
        )

    if pvs_records:
        await conn.executemany(
            """
            INSERT INTO property_value_scalar (
                uuid, node_property_id, property_id, node_id,
                value_text, value_boolean, value_float, value_integer,
                create_date, write_date, create_uid, write_uid
            ) VALUES (
                $1::uuid, $2, $3, $4,
                $5, $6, $7, $8,
                $9, $10, $11, $11
            )
        """,
            pvs_records,
            timeout=None,
        )

    stats["property_values"] = len(pvs_records)

    # ── Phase 8: Batch insert property value relations ──────
    pvr_data = dump_data.get("property_value_relations", [])
    logger.info(f"Importing {len(pvr_data)} property value relations")

    pvr_records = []
    for pvr in pvr_data:
        np_id = node_property_id_map.get(int(pvr["node_property_id"]))
        p_id = property_id_map.get(int(pvr["property_id"]))
        n_id = node_id_map.get(int(pvr["node_id"]))
        t_id = node_id_map.get(int(pvr["target_id"]))

        if np_id is None or p_id is None or n_id is None or t_id is None:
            logger.warning("Skipping property_value_relation: missing FK mapping")
            continue

        pvr_uuid = map_uuid(pvr.get("uuid"))
        pvr_records.append(
            (
                pvr_uuid,
                np_id,
                p_id,
                n_id,
                t_id,
                _to_int(pvr.get("order", 0)),
                _parse_datetime(pvr.get("create_date")) or now,
                _parse_datetime(pvr.get("write_date")) or now,
                user_id,
            )
        )

    if pvr_records:
        await conn.executemany(
            """
            INSERT INTO property_value_relation (
                uuid, node_property_id, property_id, node_id, target_id,
                "order", create_date, write_date, create_uid, write_uid
            ) VALUES (
                $1::uuid, $2, $3, $4, $5,
                $6, $7, $8, $9, $9
            )
        """,
            pvr_records,
            timeout=None,
        )

    stats["property_values"] += len(pvr_records)

    # ── Phase 9: Batch insert property value selections ─────
    pvsel_data = dump_data.get("property_value_selections", [])
    logger.info(f"Importing {len(pvsel_data)} property value selections")

    pvsel_records = []
    for pvsel in pvsel_data:
        np_id = node_property_id_map.get(int(pvsel["node_property_id"]))
        p_id = property_id_map.get(int(pvsel["property_id"]))
        n_id = node_id_map.get(int(pvsel["node_id"]))
        sl_id = selection_line_id_map.get(int(pvsel["selection_line_id"]))

        if np_id is None or p_id is None or n_id is None or sl_id is None:
            logger.warning("Skipping property_value_selection: missing FK mapping")
            continue

        pvsel_uuid = map_uuid(pvsel.get("uuid"))
        pvsel_records.append(
            (
                pvsel_uuid,
                np_id,
                p_id,
                n_id,
                sl_id,
                _parse_datetime(pvsel.get("create_date")) or now,
                _parse_datetime(pvsel.get("write_date")) or now,
                user_id,
            )
        )

    if pvsel_records:
        await conn.executemany(
            """
            INSERT INTO property_value_selection (
                uuid, node_property_id, property_id, node_id,
                selection_line_id, create_date, write_date,
                create_uid, write_uid
            ) VALUES (
                $1::uuid, $2, $3, $4,
                $5, $6, $7,
                $8, $8
            )
        """,
            pvsel_records,
            timeout=None,
        )

    stats["property_values"] += len(pvsel_records)

    # ── Phase 10: Batch insert class extends ────────────────
    ce_data = dump_data.get("class_extends", [])
    logger.info(f"Importing {len(ce_data)} class extends")

    ce_records = []
    for ce in ce_data:
        target = node_id_map.get(int(ce["target_id"]))
        source = node_id_map.get(int(ce["source_id"]))

        if target is None or source is None:
            logger.warning("Skipping class_extend: missing node mapping")
            continue

        ce_records.append((target, source, _to_int(ce.get("sequence", 0))))

    if ce_records:
        await conn.executemany(
            """
            INSERT INTO class_extend (target_id, source_id, sequence)
            VALUES ($1, $2, $3)
            ON CONFLICT (target_id, source_id) DO NOTHING
        """,
            ce_records,
            timeout=None,
        )

    stats["class_extends"] = len(ce_records)

    # ── Phase 11: Batch insert class properties ─────────────
    cp_data = dump_data.get("class_properties", [])
    logger.info(f"Importing {len(cp_data)} class properties")

    cp_records = []
    for cp in cp_data:
        class_n_id = node_id_map.get(int(cp["class_node_id"]))
        p_id = property_id_map.get(int(cp["property_id"]))

        if class_n_id is None or p_id is None:
            logger.warning("Skipping class_property: missing mapping")
            continue

        default_node_id = None
        if cp.get("default_node_id") is not None:
            default_node_id = node_id_map.get(int(cp["default_node_id"]))

        default_sel_id = None
        if cp.get("default_selection_id") is not None:
            default_sel_id = selection_line_id_map.get(int(cp["default_selection_id"]))

        cp_records.append(
            (
                class_n_id,
                p_id,
                _to_int(cp.get("sequence", 0)),
                _to_bool(cp.get("hidden", False)),
                _to_int(cp.get("default_integer")),
                float(cp["default_float"]) if cp.get("default_float") is not None else None,
                cp.get("default_text"),
                _to_bool(cp.get("default_boolean")),
                default_node_id,
                default_sel_id,
            )
        )

    if cp_records:
        await conn.executemany(
            """
            INSERT INTO class_property (
                class_node_id, property_id, sequence, hidden,
                default_integer, default_float, default_text,
                default_boolean, default_node_id, default_selection_id
            ) VALUES (
                $1, $2, $3, $4,
                $5, $6, $7,
                $8, $9, $10
            )
            ON CONFLICT (class_node_id, property_id) DO NOTHING
        """,
            cp_records,
            timeout=None,
        )

    stats["class_properties"] = len(cp_records)

    # ── Phase 12: Batch insert node links ───────────────────
    links_data = dump_data.get("links", [])
    logger.info(f"Importing {len(links_data)} node links")

    link_records = []
    for link_data in links_data:
        source = node_id_map.get(int(link_data["source_id"]))
        target = node_id_map.get(int(link_data["target_id"]))

        if source is None or target is None:
            logger.warning(
                f"Skipping node_link: source {link_data['source_id']} or target {link_data['target_id']} not found"
            )
            continue

        link_uuid = map_uuid(link_data.get("uuid"))
        link_property_id = None
        if link_data.get("property_id") is not None:
            link_property_id = property_id_map.get(int(link_data["property_id"]))

        link_name = link_data.get("name")
        if remap_uuids and link_name:
            link_name = _remap_uuids_in_text(str(link_name), uuid_map)

        link_records.append(
            (
                link_uuid,
                source,
                target,
                workspace_id,
                link_property_id,
                _to_int(link_data.get("position", 0)),
                _to_bool(link_data.get("is_tag", False)),
                _to_bool(link_data.get("is_inline_class", False)),
                link_name,
                _parse_datetime(link_data.get("create_date")) or now,
                user_id,
            )
        )

    if link_records:
        await conn.executemany(
            """
            INSERT INTO node_link (
                uuid, source_id, target_id, workspace_id, property_id,
                position, is_tag, is_inline_class, name, create_date,
                create_uid
            ) VALUES (
                $1::uuid, $2, $3, $4, $5,
                $6, $7, $8, $9, $10,
                $11
            )
        """,
            link_records,
            timeout=None,
        )

    stats["links"] = len(link_records)

    # ── Phase 13: Batch insert node views ───────────────────
    nv_data = dump_data.get("node_views", [])
    logger.info(f"Importing {len(nv_data)} node views")

    nv_records = []
    for nv in nv_data:
        nv_node_id = node_id_map.get(int(nv["node_id"]))
        if nv_node_id is None:
            logger.warning(f"Skipping node_view: node {nv['node_id']} not found")
            continue

        nv_uuid = map_uuid(nv.get("uuid"))
        query_json = nv.get("query_json", {})
        shown_properties = nv.get("shown_properties", [])
        group_by = nv.get("group_by")

        if remap_uuids:
            query_json = _remap_uuids_in_jsonb(query_json, uuid_map)
            shown_properties = _remap_uuids_in_jsonb(shown_properties, uuid_map)
            if group_by and UUID_PATTERN.match(group_by):
                group_by = uuid_map.get(group_by.lower(), group_by)

        nv_records.append(
            (
                nv_uuid,
                nv_node_id,
                str(nv.get("name", "")),
                json.dumps(query_json, default=str),
                str(nv.get("view_type", "")),
                _to_int(nv.get("order_index", 0)),
                _to_bool(nv.get("is_default", False)),
                _to_bool(nv.get("active", True)),
                json.dumps(shown_properties, default=str),
                group_by,
                _parse_datetime(nv.get("create_date")) or now,
                _parse_datetime(nv.get("write_date")) or now,
                user_id,
            )
        )

    if nv_records:
        await conn.executemany(
            """
            INSERT INTO node_view (
                uuid, node_id, name, query_json, view_type,
                order_index, is_default, active,
                shown_properties, group_by,
                create_date, write_date, create_uid, write_uid
            ) VALUES (
                $1::uuid, $2, $3, $4::jsonb, $5,
                $6, $7, $8,
                $9::jsonb, $10,
                $11, $12, $13, $13
            )
            ON CONFLICT (uuid) DO UPDATE SET
                node_id = EXCLUDED.node_id,
                name = EXCLUDED.name,
                query_json = EXCLUDED.query_json,
                view_type = EXCLUDED.view_type,
                order_index = EXCLUDED.order_index,
                is_default = EXCLUDED.is_default,
                active = EXCLUDED.active,
                shown_properties = EXCLUDED.shown_properties,
                group_by = EXCLUDED.group_by,
                write_date = EXCLUDED.write_date,
                write_uid = EXCLUDED.write_uid
        """,
            nv_records,
            timeout=None,
        )

    stats["node_views"] = len(nv_records)

    # ── Phase 14: Batch insert workspace settings ───────────
    settings_data = dump_data.get("settings", [])
    logger.info(f"Importing {len(settings_data)} workspace settings")

    settings_records = []
    for setting in settings_data:
        setting_value = setting.get("value")
        if remap_uuids and setting_value:
            setting_value = _remap_uuids_in_jsonb(setting_value, uuid_map)

        settings_records.append(
            (
                workspace_id,
                str(setting["key"]),
                json.dumps(setting_value, default=str) if setting_value is not None else None,
                now,
                user_id,
            )
        )

    if settings_records:
        await conn.executemany(
            """
            INSERT INTO setting_workspace (workspace_id, key, value,
                                           create_date, write_date,
                                           create_uid, write_uid)
            VALUES ($1, $2, $3::jsonb, $4, $4, $5, $5)
            ON CONFLICT (workspace_id, key) DO UPDATE
                SET value = EXCLUDED.value, write_date = EXCLUDED.write_date
        """,
            settings_records,
            timeout=None,
        )

    stats["settings"] = len(settings_records)

    # ── Phase 15: Re-enable triggers and rebuild ────────────
    logger.info("Re-enabling node triggers")
    await conn.execute("ALTER TABLE node ENABLE TRIGGER node_search_update")
    await conn.execute("ALTER TABLE node ENABLE TRIGGER node_path_after_insert")
    await conn.execute("ALTER TABLE node ENABLE TRIGGER node_path_after_update")
    await conn.execute("ALTER TABLE node ENABLE TRIGGER node_path_before_delete")
    await conn.execute("ALTER TABLE node ENABLE TRIGGER node_write_date")
    await conn.execute("ALTER TABLE node ENABLE TRIGGER node_update_workspace_write_date")
    await conn.execute("""
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_node_version_capture') THEN
                ALTER TABLE node ENABLE TRIGGER trg_node_version_capture;
            END IF;
        END $$;
    """)

    # Rebuild node_path closure table (replaces disabled insert/update triggers)
    logger.info("Rebuilding node_path closure table")
    await conn.execute("SELECT rebuild_node_path()", timeout=None)

    # Rebuild search vectors for imported nodes
    logger.info("Rebuilding search vectors for imported nodes")
    await conn.execute(
        """
        UPDATE node SET search_vector = to_tsvector(
            COALESCE(search_language, 'english')::regconfig,
            COALESCE(name, '')
        ) WHERE workspace_id = $1
    """,
        workspace_id,
        timeout=None,
    )

    logger.info(f"Import complete: {stats}")
    return stats, uuid_map


# ============================================================
# IMPORT TO NEW WORKSPACE
# ============================================================


async def import_dump_to_new_workspace(
    user_id_str: str,
    dump_data: dict,
    workspace_name: str,
    remap_uuids: bool = True,
) -> dict[str, Any]:
    """Import a dump file into a brand new workspace.

    Creates a new workspace (without default seeding) and writes all data.
    When remap_uuids is True (default), generates new UUIDs for every entity.
    When False, preserves original UUIDs (for cross-instance migration).

    Args:
        user_id_str: User ID string
        dump_data: Parsed dump JSON
        workspace_name: Name for the new workspace

    Returns:
        Dict with workspace info and import stats
    """
    numeric_user_id = await _get_numeric_user_id(user_id_str)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id_str}")

    async with get_connection() as conn:
        # Check name uniqueness
        existing = await conn.fetchrow(
            "SELECT id FROM workspace WHERE create_uid = $1 AND name = $2 AND active = TRUE",
            numeric_user_id,
            workspace_name,
        )
        if existing:
            raise ValueError(f"Workspace '{workspace_name}' already exists")

        # Create workspace record (NO seeding - we'll fill from dump)
        async with conn.transaction():
            ws_row = await conn.fetchrow(
                """
                INSERT INTO workspace (name, create_uid, write_uid, is_shared, active)
                VALUES ($1, $2, $2, FALSE, TRUE)
                RETURNING id, uuid, name, create_date
            """,
                workspace_name,
                numeric_user_id,
            )

            if ws_row is None:
                raise RuntimeError("Failed to create workspace")

            workspace_id = ws_row["id"]
            workspace_uuid = str(ws_row["uuid"])

            logger.info(f"Created workspace '{workspace_name}' (id={workspace_id}, uuid={workspace_uuid}) for import")

            # Run the core import
            stats, uuid_map = await _import_dump_core(
                conn,
                dump_data,
                workspace_id,
                numeric_user_id,
                remap_uuids=remap_uuids,
            )

        # Activate the new workspace
        _active_workspaces[user_id_str] = workspace_uuid

        return {
            "uuid": workspace_uuid,
            "name": workspace_name,
            "created_at": ws_row["create_date"].isoformat() if ws_row["create_date"] else None,
            "stats": stats,
            "uuid_map": uuid_map,
        }


# ============================================================
# RESTORE WORKSPACE FROM DUMP
# ============================================================


async def restore_workspace_from_dump(
    user_id_str: str,
    workspace_uuid: str,
    dump_data: dict,
) -> dict[str, Any]:
    """Restore an existing workspace to a previous state from a dump file.

    Deletes all current data in the workspace and re-imports from the dump
    using original UUIDs (no remapping).

    WARNING: This is destructive - all current workspace data will be replaced.

    Args:
        user_id_str: User ID string
        workspace_uuid: UUID of the workspace to restore
        dump_data: Parsed dump JSON

    Returns:
        Dict with restore stats
    """
    numeric_user_id = await _get_numeric_user_id(user_id_str)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id_str}")

    async with get_connection() as conn:
        # Find workspace
        ws_row = await conn.fetchrow(
            """
            SELECT g.id, g.uuid, g.name FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.uuid::text = $1 AND g.active = TRUE
              AND (g.create_uid = $2 OR gs.user_id = $2)
        """,
            workspace_uuid,
            numeric_user_id,
        )

        if not ws_row:
            raise ValueError(f"Workspace '{workspace_uuid}' not found")

        workspace_id = ws_row["id"]

        async with conn.transaction():
            # Delete all existing data in the workspace
            # Order matters for FK constraints (or rely on CASCADE)
            logger.warning(f"Restoring workspace '{ws_row['name']}' (id={workspace_id}) - DELETING ALL EXISTING DATA")

            # node_view, node_link, property values, node_property,
            # class_property, class_extend, property_class_filter,
            # property_selection_line, property, node
            # Most of these cascade from node and property deletes

            # Delete node views (references nodes)
            await conn.execute(
                """
                DELETE FROM node_view
                WHERE node_id IN (SELECT id FROM node WHERE workspace_id = $1)
            """,
                workspace_id,
            )

            # Delete node links
            await conn.execute(
                "DELETE FROM node_link WHERE workspace_id = $1",
                workspace_id,
            )

            # Delete settings
            await conn.execute(
                "DELETE FROM setting_workspace WHERE workspace_id = $1",
                workspace_id,
            )

            # Delete nodes (CASCADE handles node_property, property_values,
            # class_property, class_extend, node_path, etc.)
            await conn.execute(
                "DELETE FROM node WHERE workspace_id = $1",
                workspace_id,
            )

            # Delete properties (CASCADE handles property_selection_line,
            # property_class_filter)
            await conn.execute(
                "DELETE FROM property WHERE workspace_id = $1",
                workspace_id,
            )

            logger.info("Existing data deleted, importing from dump")

            # Import dump data (keeping original UUIDs)
            stats, _ = await _import_dump_core(
                conn,
                dump_data,
                workspace_id,
                numeric_user_id,
                remap_uuids=False,
            )

        return {
            "uuid": str(ws_row["uuid"]),
            "name": ws_row["name"],
            "stats": stats,
        }


# ============================================================
# ZIP EXPORT (database + assets)
# ============================================================


async def export_workspace_zip(
    user_id_str: str,
    workspace_uuid: str,
    progress_callback = None,
) -> Path:
    """Export a workspace as a ZIP containing the JSON dump and all asset files.

    ZIP structure:
        dump.json
        assets/{asset_uuid}/main.{ext}
        assets/{asset_uuid}/thumbnail.webp

    Args:
        user_id_str: User ID string
        workspace_uuid: UUID of the workspace to export
        progress_callback: Optional callable(progress: int, status_text: str)

    Returns:
        Path to the generated ZIP file
    """
    import zipfile

    numeric_user_id = await _get_numeric_user_id(user_id_str)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id_str}")

    async with get_connection() as conn:
        workspace = await conn.fetchrow(
            """
            SELECT g.id, g.uuid, g.name
            FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.uuid::text = $2 AND g.active = TRUE
              AND (g.create_uid = $1 OR gs.user_id = $1)
        """,
            numeric_user_id,
            workspace_uuid,
        )

        if not workspace:
            raise ValueError(f"Workspace '{workspace_uuid}' not found")

        workspace_id = workspace["id"]
        ws_name = workspace["name"]
        ws_uuid = str(workspace["uuid"])

        if progress_callback:
            progress_callback(5, "Fetching workspace data…")

    dump_data = await export_workspace_full(conn, workspace_id)

    if progress_callback:
        progress_callback(25, "Building ZIP archive…")

    # Build ZIP
    export_dir = get_data_dir() / "workspaces" / ws_uuid / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    zip_path = export_dir / f"{ws_name}_dump_{timestamp}.zip"

    assets_dir = get_data_dir() / "workspaces" / ws_uuid / "assets"
    asset_folders = [f for f in assets_dir.iterdir() if f.is_dir()] if assets_dir.exists() else []
    total_assets = sum(1 for folder in asset_folders for _ in folder.iterdir() if _.is_file())

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # Add JSON dump
        dump_json = json.dumps(dump_data, default=str, indent=2)
        zf.writestr("dump.json", dump_json)

        if progress_callback:
            progress_callback(50, "Copying asset files…")

        # Add all asset files
        copied = 0
        if assets_dir.exists():
            for asset_folder in asset_folders:
                if asset_folder.is_dir():
                    for asset_file in asset_folder.iterdir():
                        if asset_file.is_file():
                            arcname = f"assets/{asset_folder.name}/{asset_file.name}"
                            zf.write(asset_file, arcname)
                            copied += 1
                            if progress_callback and total_assets > 0:
                                progress = 50 + int((copied / total_assets) * 45)
                                progress_callback(progress, f"Copying asset files ({copied}/{total_assets})…")

    if progress_callback:
        progress_callback(100, "Export complete")

    file_size_mb = zip_path.stat().st_size / (1024 * 1024)
    logger.info(f"Exported workspace '{ws_name}' as ZIP to {zip_path} ({file_size_mb:.2f} MB)")

    return zip_path


# ============================================================
# ZIP IMPORT (database + assets)
# ============================================================


async def import_workspace_from_zip(
    user_id_str: str,
    zip_path: Path,
    workspace_name: str,
) -> dict[str, Any]:
    """Import a workspace from a ZIP file containing dump.json and assets.

    Creates a new workspace preserving original UUIDs and copies asset files
    into the new workspace's assets directory.

    Args:
        user_id_str: User ID string
        zip_path: Path to the ZIP file
        workspace_name: Name for the new workspace

    Returns:
        Dict with workspace info and import stats
    """
    import tempfile as _tempfile
    import zipfile

    if not zipfile.is_zipfile(zip_path):
        raise ValueError("Invalid ZIP file")

    with _tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)

        # Extract ZIP
        with zipfile.ZipFile(zip_path, "r") as zf:
            # Security: validate all paths to prevent zip-slip
            for info in zf.infolist():
                target = (tmpdir_path / info.filename).resolve()
                if not str(target).startswith(str(tmpdir_path.resolve())):
                    raise ValueError("ZIP contains unsafe path entries")
            zf.extractall(tmpdir_path)

        # Read dump.json
        dump_json_path = tmpdir_path / "dump.json"
        if not dump_json_path.exists():
            raise ValueError("ZIP file does not contain dump.json")

        with open(dump_json_path, encoding="utf-8") as f:
            dump_data = json.load(f)

        # Import the workspace preserving original UUIDs
        result = await import_dump_to_new_workspace(
            user_id_str=user_id_str,
            dump_data=dump_data,
            workspace_name=workspace_name,
            remap_uuids=False,
        )

        new_workspace_uuid = result["uuid"]
        result.pop("uuid_map", None)

        # Copy assets into new workspace directory (UUIDs are preserved)
        extracted_assets = tmpdir_path / "assets"
        if extracted_assets.exists() and extracted_assets.is_dir():
            new_assets_dir = get_data_dir() / "workspaces" / new_workspace_uuid / "assets"
            shutil.copytree(extracted_assets, new_assets_dir, dirs_exist_ok=True)

            logger.info(f"Copied assets for workspace '{workspace_name}' to {new_assets_dir}")

    return result


# ============================================================
# ENHANCED EXPORT
# ============================================================


async def export_workspace_to_file(
    user_id_str: str,
    workspace_name: str,
) -> Path:
    """Export a workspace to a comprehensive JSON dump file.

    Args:
        user_id_str: User ID string
        workspace_name: Name of the workspace to export

    Returns:
        Path to the exported JSON file
    """
    numeric_user_id = await _get_numeric_user_id(user_id_str)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id_str}")

    async with get_connection() as conn:
        # Find workspace
        workspace = await conn.fetchrow(
            """
            SELECT g.id, g.uuid, g.name
            FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.name = $2 AND g.active = TRUE
              AND (g.create_uid = $1 OR gs.user_id = $1)
        """,
            numeric_user_id,
            workspace_name,
        )

        if not workspace:
            raise ValueError(f"Workspace '{workspace_name}' not found")

        workspace_id = workspace["id"]
        workspace_uuid = str(workspace["uuid"])

        # Create full dump
        dump_data = await export_workspace_full(conn, workspace_id)

    # Write to file
    export_dir = get_data_dir() / "workspaces" / workspace_uuid / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    export_path = export_dir / f"{workspace_name}_dump.json"

    with open(export_path, "w", encoding="utf-8") as f:
        json.dump(dump_data, f, default=str, indent=2)

    file_size_mb = export_path.stat().st_size / (1024 * 1024)
    logger.info(f"Exported workspace '{workspace_name}' to {export_path} ({file_size_mb:.2f} MB)")

    return export_path


async def export_workspace_by_uuid(
    user_id_str: str,
    workspace_uuid: str,
) -> Path:
    """Export a workspace by UUID to a comprehensive JSON dump file.

    Args:
        user_id_str: User ID string
        workspace_uuid: UUID of the workspace to export

    Returns:
        Path to the exported JSON file
    """
    numeric_user_id = await _get_numeric_user_id(user_id_str)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id_str}")

    async with get_connection() as conn:
        workspace = await conn.fetchrow(
            """
            SELECT g.id, g.uuid, g.name
            FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.uuid::text = $2 AND g.active = TRUE
              AND (g.create_uid = $1 OR gs.user_id = $1)
        """,
            numeric_user_id,
            workspace_uuid,
        )

        if not workspace:
            raise ValueError(f"Workspace '{workspace_uuid}' not found")

        workspace_id = workspace["id"]
        ws_name = workspace["name"]

        dump_data = await export_workspace_full(conn, workspace_id)

    export_dir = get_data_dir() / "workspaces" / workspace_uuid / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    export_path = export_dir / f"{ws_name}_dump.json"

    with open(export_path, "w", encoding="utf-8") as f:
        json.dump(dump_data, f, default=str, indent=2)

    return export_path


# ---------------------------------------------------------------------------
# Formatted export (markdown / text / json) as ZIP
# ---------------------------------------------------------------------------


async def export_workspace_formatted_zip(
    user_id_str: str,
    workspace_uuid: str,
    format: str,
    include_assets: bool = False,
    progress_callback = None,
) -> Path:
    """Export all pages in a workspace as a ZIP of formatted files.

    Supported formats:
        - "markdown": .md files with YAML frontmatter
        - "text":     .txt plain text files
        - "json":     .json AST files

    Args:
        user_id_str: User ID string
        workspace_uuid: UUID of the workspace to export
        format: One of "markdown", "text", "json"
        include_assets: Whether to include asset files in the ZIP and rewrite
            asset links in markdown exports to relative paths.
        progress_callback: Optional callable(progress: int, status_text: str)

    Returns:
        Path to the generated ZIP file
    """
    import zipfile

    from .node_export import export_nodes

    numeric_user_id = await _get_numeric_user_id(user_id_str)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id_str}")

    async with get_connection() as conn:
        workspace = await conn.fetchrow(
            """
            SELECT g.id, g.uuid, g.name
            FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.uuid::text = $2 AND g.active = TRUE
              AND (g.create_uid = $1 OR gs.user_id = $1)
        """,
            numeric_user_id,
            workspace_uuid,
        )

        if not workspace:
            raise ValueError(f"Workspace '{workspace_uuid}' not found")

        workspace_id = workspace["id"]
        ws_name = workspace["name"]
        ws_uuid = str(workspace["uuid"])

        if progress_callback:
            progress_callback(5, "Fetching pages…")

        # Fetch all pages
        page_rows = await conn.fetch(
            """
            SELECT uuid::text as uuid, name
            FROM node
            WHERE workspace_id = $1 AND is_page = TRUE
              AND is_deleted = FALSE AND active = TRUE
            ORDER BY sequence, id
        """,
            workspace_id,
        )

        page_uuids = [row["uuid"] for row in page_rows]

        # Fetch all assets for path mapping if needed
        asset_path_map: dict[str, str] = {}
        asset_files: dict[str, Path] = {}
        if include_assets:
            asset_rows = await conn.fetch(
                """
                SELECT n.uuid::text as uuid, n.name
                FROM node n
                WHERE n.workspace_id = $1 AND n.is_asset = TRUE
                  AND n.is_deleted = FALSE AND n.active = TRUE
            """,
                workspace_id,
            )
            assets_dir = get_data_dir() / "workspaces" / ws_uuid / "assets"
            for row in asset_rows:
                asset_uuid = row["uuid"]
                asset_folder = assets_dir / asset_uuid
                if asset_folder.exists() and asset_folder.is_dir():
                    for f in asset_folder.iterdir():
                        if f.is_file() and not f.name.endswith("_thumbnail.webp"):
                            rel_path = f"./assets/{asset_uuid}/{f.name}"
                            asset_path_map[asset_uuid] = rel_path
                            asset_files[asset_uuid] = f
                            break

    total_pages = len(page_uuids)
    if total_pages == 0:
        raise ValueError("No pages found in workspace")

    if progress_callback:
        progress_callback(10, f"Exporting {total_pages} pages…")

    # Export dir
    export_dir = get_data_dir() / "workspaces" / ws_uuid / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    fmt_code = {"markdown": "md", "text": "txt", "json": "json"}[format]
    zip_path = export_dir / f"{ws_name}_{fmt_code}_{timestamp}.zip"

    # Build ZIP
    ext = {"markdown": "md", "text": "txt", "json": "json"}[format]
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, node_uuid in enumerate(page_uuids):
            try:
                content_bytes, _fn, _mime = await export_nodes(
                    user_id_str,
                    node_ids=[node_uuid],
                    format=format,
                    include_children=True,
                    layout="outline",
                    formatting=False,
                    properties="none",
                    link_style="raw",
                    asset_path_map=asset_path_map if include_assets and format == "markdown" else None,
                    highlight_syntax=False,
                    link_target_brackets=False,
                    skip_root=True,
                )
                content = content_bytes.decode("utf-8")

                if format == "markdown":
                    # Add YAML frontmatter
                    async with get_connection() as conn:
                        metadata = await _fetch_page_metadata(conn, workspace_id, node_uuid)
                    frontmatter = _build_yaml_frontmatter(metadata)
                    content = frontmatter + content

                filename = f"{node_uuid}.{ext}"
                zf.writestr(filename, content)
            except Exception as exc:
                logger.warning(f"Failed to export page {node_uuid}: {exc}")
                continue

            if progress_callback:
                progress = 10 + int(((i + 1) / total_pages) * 80)
                progress_callback(progress, f"Exported page {i + 1} of {total_pages}…")

        # Include asset files in the ZIP
        if include_assets:
            total_assets = len(asset_files)
            for idx, (asset_uuid, file_path) in enumerate(asset_files.items()):
                arcname = f"assets/{asset_uuid}/{file_path.name}"
                zf.write(file_path, arcname)
                if progress_callback:
                    progress = 90 + int(((idx + 1) / total_assets) * 10)
                    progress_callback(progress, f"Copying asset files ({idx + 1}/{total_assets})…")

    if progress_callback:
        progress_callback(100, "Export complete")

    return zip_path


def _extract_plain_text(name: str | None) -> str:
    """Extract plain text from a node's name (AST JSON or plain text)."""
    if not name:
        return "untitled"
    try:
        ast = parse_ast(name)
        opts = StringifyOptions(mode=StringifyMode.TEXT_ONLY)
        return stringify_ast(ast, opts) or "untitled"
    except Exception:
        return name.strip() or "untitled"


def _sanitize_filename(name: str) -> str:
    """Sanitize a string for use as a filename."""
    import re as _re

    return _re.sub(r"[^\w\-_.]", "_", name).strip("_") or "untitled"


async def _fetch_page_metadata(conn, workspace_id: int, node_uuid: str) -> dict:
    """Fetch minimal metadata for a page's YAML frontmatter."""
    node_row = await conn.fetchrow(
        """
        SELECT id, uuid::text as uuid, name, is_page, is_day, is_month, is_year,
               color, icon, class_ids, parent_id, create_date, write_date
        FROM node
        WHERE workspace_id = $1 AND uuid::text = $2
        """,
        workspace_id,
        node_uuid,
    )
    if not node_row:
        raise ValueError(f"Node not found: {node_uuid}")

    metadata = {
        "uuid": str(node_row["uuid"]),
        "title": _extract_plain_text(node_row["name"]),
        "create_date": node_row["create_date"].isoformat() if node_row["create_date"] else None,
        "write_date": node_row["write_date"].isoformat() if node_row["write_date"] else None,
    }

    if node_row["color"]:
        metadata["color"] = node_row["color"]

    # Ancestors
    ancestor_rows = await conn.fetch(
        """
        SELECT n.uuid::text as uuid, n.name
        FROM node_path np
        JOIN node n ON n.id = np.ancestor_id
        WHERE np.descendant_id = $1 AND np.depth > 0
        ORDER BY np.depth DESC
        """,
        node_row["id"],
    )
    if ancestor_rows:
        metadata["parents"] = [
            {"uuid": str(row["uuid"]), "title": _extract_plain_text(row["name"])} for row in ancestor_rows
        ]

    # Tags
    tag_rows = await conn.fetch(
        """
        SELECT n.uuid::text as uuid, n.name
        FROM node_link nl
        JOIN node n ON n.id = nl.target_id
        WHERE nl.source_id = $1 AND nl.is_tag = TRUE AND nl.property_id IS NULL
        ORDER BY nl.position
        """,
        node_row["id"],
    )
    if tag_rows:
        metadata["tags"] = [{"uuid": str(row["uuid"]), "name": _extract_plain_text(row["name"])} for row in tag_rows]

    # Classes
    class_ids = list(node_row["class_ids"] or [])
    if class_ids:
        class_rows = await conn.fetch(
            "SELECT id, uuid::text as uuid, name FROM node WHERE id = ANY($1) AND active = TRUE",
            class_ids,
        )
        metadata["classes"] = [
            {"uuid": str(row["uuid"]), "name": _extract_plain_text(row["name"])} for row in class_rows
        ]

    # Properties
    prop_rows = await conn.fetch(
        """
        SELECT p.name AS property_name, p.type AS property_type, p.is_multi,
               pvs.value_text, pvs.value_boolean, pvs.value_float, pvs.value_integer,
               psl.name AS selection_value,
               pvr.target_id AS relation_target_id,
               rel.uuid::text AS relation_target_uuid, rel.name AS relation_target_name
        FROM node_property np
        JOIN property p ON p.id = np.property_id
        LEFT JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
        LEFT JOIN property_value_relation pvr ON pvr.node_property_id = np.id
        LEFT JOIN property_value_selection pvsel ON pvsel.node_property_id = np.id
        LEFT JOIN property_selection_line psl ON psl.id = pvsel.selection_line_id
        LEFT JOIN node rel ON rel.id = pvr.target_id
        WHERE np.node_id = $1 AND p.active = TRUE
        ORDER BY p.name
        """,
        node_row["id"],
    )
    props_agg: dict[str, dict] = {}
    for row in prop_rows:
        prop_name = row["property_name"]
        prop_type = row["property_type"]
        if prop_name not in props_agg:
            props_agg[prop_name] = {"type": prop_type, "values": []}
        value = None
        if prop_type == "integer" and row["value_integer"] is not None:
            value = row["value_integer"]
        elif prop_type == "float" and row["value_float"] is not None:
            value = row["value_float"]
        elif prop_type == "boolean" and row["value_boolean"] is not None:
            value = bool(row["value_boolean"])
        elif prop_type == "date" and row["value_text"] is not None:
            value = row["value_text"]
        elif prop_type == "selection" and row["selection_value"] is not None:
            value = row["selection_value"]
        elif prop_type in ("node", "text") and row["relation_target_id"] is not None:
            value = {
                "uuid": str(row["relation_target_uuid"]) if row["relation_target_uuid"] else None,
                "name": _extract_plain_text(row["relation_target_name"]),
            }
        if value is not None and value not in props_agg[prop_name]["values"]:
            props_agg[prop_name]["values"].append(value)

    if props_agg:
        props_out = {}
        for prop_name, prop_data in props_agg.items():
            values = prop_data["values"]
            prop_type = prop_data["type"]
            if not values:
                continue
            if len(values) == 1 and prop_type != "text":
                props_out[prop_name] = values[0]
            else:
                props_out[prop_name] = values
        if props_out:
            metadata["properties"] = props_out

    if node_row["icon"]:
        metadata["icon"] = node_row["icon"]

    return metadata


def _yaml_scalar(value: str) -> str:
    """Escape a string for YAML."""
    if not value:
        return '""'
    if "\n" in value:
        return "|\n" + "\n".join("  " + line for line in value.split("\n"))
    if any(c in value for c in [":", "#", "{", "}", "[", "]", ",", "&", "*", "!", "|", ">", "'", '"', "%", "@", "`"]):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return value


def _yaml_lines(value, indent: int = 0):
    """Yield YAML lines for a value at the given indentation level."""
    prefix = "  " * indent
    if value is None:
        yield prefix + "null"
    elif isinstance(value, bool):
        yield prefix + ("true" if value else "false")
    elif isinstance(value, (int, float)):
        yield prefix + str(value)
    elif isinstance(value, str):
        yield prefix + _yaml_scalar(value)
    elif isinstance(value, list):
        if not value:
            yield prefix + "[]"
        else:
            for item in value:
                if isinstance(item, dict) and item or isinstance(item, list) and item:
                    first = True
                    for line in _yaml_lines(item, indent + 1):
                        if first:
                            yield prefix + "- " + line[len(prefix + "  ") :]
                            first = False
                        else:
                            yield line
                else:
                    scalar = (
                        _yaml_scalar(item)
                        if isinstance(item, str)
                        else "true"
                        if item is True
                        else "false"
                        if item is False
                        else "null"
                        if item is None
                        else str(item)
                    )
                    yield prefix + "- " + scalar
    elif isinstance(value, dict):
        if not value:
            yield prefix + "{}"
        else:
            for k, v in value.items():
                if isinstance(v, (dict, list)) and v:
                    yield prefix + k + ":"
                    for line in _yaml_lines(v, indent + 1):
                        yield line
                else:
                    scalar = (
                        _yaml_scalar(v)
                        if isinstance(v, str)
                        else "true"
                        if v is True
                        else "false"
                        if v is False
                        else "null"
                        if v is None
                        else str(v)
                    )
                    yield prefix + k + ": " + scalar
    else:
        yield prefix + str(value)


def _build_yaml_frontmatter(data: dict) -> str:
    """Build a YAML frontmatter block from a dict."""
    lines = ["---"]
    for key, value in data.items():
        if isinstance(value, (dict, list)) and value:
            lines.append(key + ":")
            for line in _yaml_lines(value, 1):
                lines.append(line)
        else:
            scalar = (
                _yaml_scalar(value)
                if isinstance(value, str)
                else "true"
                if value is True
                else "false"
                if value is False
                else "null"
                if value is None
                else str(value)
            )
            lines.append(key + ": " + scalar)
    lines.append("---")
    return "\n".join(lines) + "\n\n"
