"""Workspace import/export and restore functionality.

Provides:
- Full workspace export (comprehensive dump with all data)
- Import dump to new workspace (with UUID remapping)
- Restore workspace from dump file (keeping original UUIDs)
"""
from __future__ import annotations

import json
import re
import uuid as uuid_module
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List, Optional

import asyncpg

from .db.connection import get_connection, DATA_DIR
from .logging_config import get_logger

logger = get_logger(__name__)

# UUID regex for finding UUIDs in text
UUID_PATTERN = re.compile(
    r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
)


def _parse_datetime(value: Any) -> Optional[datetime]:
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
                    return datetime.now(timezone.utc)
    return None


def _to_bool(value: Any) -> Optional[bool]:
    """Convert value to bool."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in ('true', '1', 'yes')
    return bool(value)


def _to_int(value: Any) -> Optional[int]:
    """Convert value to int."""
    if value is None:
        return None
    return int(value)


def _remap_uuids_in_text(text: str, uuid_map: Dict[str, str]) -> str:
    """Replace all mapped UUIDs in a text string."""
    if not text or not uuid_map:
        return text

    def replace_uuid(match: re.Match[str]) -> str:
        old_uuid = match.group(0).lower()
        return uuid_map.get(old_uuid, match.group(0))

    return UUID_PATTERN.sub(replace_uuid, text)


def _remap_uuids_in_jsonb(data: Any, uuid_map: Dict[str, str]) -> Any:
    """Replace all mapped UUIDs in a JSONB value."""
    if data is None or not uuid_map:
        return data
    text = json.dumps(data, default=str)
    text = _remap_uuids_in_text(text, uuid_map)
    return json.loads(text)


def _remap_int_list(values: Any, id_map: Dict[int, int]) -> List[int]:
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
    workspace = await conn.fetchrow(
        "SELECT uuid, name FROM workspace WHERE id = $1", workspace_id
    )
    if not workspace:
        raise ValueError(f"Workspace {workspace_id} not found")

    # Nodes (including integer id for FK resolution)
    nodes = await conn.fetch("""
        SELECT id, uuid, name, icon, color, parent_id, page_id, sequence,
               collapsed, active, version, is_class, is_page, is_day,
               is_month, is_year, is_asset, is_template, is_comment,
               class_ids, classes_path, open_date, create_date, write_date,
               aliased_id, is_deleted, deleted_at
        FROM node WHERE workspace_id = $1
    """, workspace_id)

    # Node links
    links = await conn.fetch("""
        SELECT id, uuid, source_id, target_id, property_id, position,
               is_tag, is_inline_class, name, create_date
        FROM node_link WHERE workspace_id = $1
    """, workspace_id)

    # Properties
    properties = await conn.fetch("""
        SELECT id, uuid, name, icon, type, is_multi, is_system, is_local,
               node_id, icon_visibility, active, create_date, write_date
        FROM property WHERE workspace_id = $1
    """, workspace_id)

    # Property selection lines
    selection_lines = await conn.fetch("""
        SELECT psl.id, psl.uuid, psl.property_id, psl.name, psl.icon,
               psl.create_date, psl.write_date
        FROM property_selection_line psl
        JOIN property p ON psl.property_id = p.id
        WHERE p.workspace_id = $1
    """, workspace_id)

    # Node properties
    node_properties = await conn.fetch("""
        SELECT np.id, np.uuid, np.node_id, np.property_id,
               np.create_date, np.write_date
        FROM node_property np
        JOIN node n ON np.node_id = n.id
        WHERE n.workspace_id = $1
    """, workspace_id)

    # Property value scalars
    value_scalars = await conn.fetch("""
        SELECT pvs.id, pvs.uuid, pvs.node_property_id, pvs.property_id,
               pvs.node_id, pvs.value_text, pvs.value_boolean,
               pvs.value_float, pvs.value_integer,
               pvs.create_date, pvs.write_date
        FROM property_value_scalar pvs
        JOIN node n ON pvs.node_id = n.id
        WHERE n.workspace_id = $1
    """, workspace_id)

    # Property value relations
    value_relations = await conn.fetch("""
        SELECT pvr.id, pvr.uuid, pvr.node_property_id, pvr.property_id,
               pvr.node_id, pvr.target_id, pvr."order",
               pvr.create_date, pvr.write_date
        FROM property_value_relation pvr
        JOIN node n ON pvr.node_id = n.id
        WHERE n.workspace_id = $1
    """, workspace_id)

    # Property value selections
    value_selections = await conn.fetch("""
        SELECT pvsel.id, pvsel.uuid, pvsel.node_property_id,
               pvsel.property_id, pvsel.node_id, pvsel.selection_line_id,
               pvsel.create_date, pvsel.write_date
        FROM property_value_selection pvsel
        JOIN node n ON pvsel.node_id = n.id
        WHERE n.workspace_id = $1
    """, workspace_id)

    # Class properties
    class_properties = await conn.fetch("""
        SELECT cp.id, cp.class_node_id, cp.property_id, cp.sequence,
               cp.hidden, cp.default_integer, cp.default_float,
               cp.default_text, cp.default_boolean,
               cp.default_node_id, cp.default_selection_id
        FROM class_property cp
        JOIN node n ON cp.class_node_id = n.id
        WHERE n.workspace_id = $1
    """, workspace_id)

    # Class extends
    class_extends = await conn.fetch("""
        SELECT ce.id, ce.target_id, ce.source_id, ce.sequence
        FROM class_extend ce
        JOIN node n ON ce.target_id = n.id
        WHERE n.workspace_id = $1
    """, workspace_id)

    # Property class filters
    class_filters = await conn.fetch("""
        SELECT pcf.id, pcf.property_id, pcf.class_node_id
        FROM property_class_filter pcf
        JOIN property p ON pcf.property_id = p.id
        WHERE p.workspace_id = $1
    """, workspace_id)

    # Node views
    node_views = await conn.fetch("""
        SELECT nv.id, nv.uuid, nv.node_id, nv.name, nv.query_json,
               nv.view_type, nv.order_index, nv.is_default, nv.active,
               nv.shown_properties, nv.group_by,
               nv.create_date, nv.write_date
        FROM node_view nv
        JOIN node n ON nv.node_id = n.id
        WHERE n.workspace_id = $1
    """, workspace_id)

    # Workspace settings
    settings = await conn.fetch(
        "SELECT key, value FROM setting_workspace WHERE workspace_id = $1",
        workspace_id,
    )

    return {
        "version": 3,
        "workspace": {
            "uuid": str(workspace['uuid']),
            "name": workspace['name'],
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
) -> Dict[str, Any]:
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
    now = datetime.now(timezone.utc)
    version = dump_data.get("version", 2)

    # ── Build UUID mapping ──────────────────────────────────
    uuid_map: Dict[str, str] = {}  # old_uuid_lower -> new_uuid

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
    node_id_map: Dict[int, int] = {}
    property_id_map: Dict[int, int] = {}
    selection_line_id_map: Dict[int, int] = {}
    node_property_id_map: Dict[int, int] = {}

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

    # ── Phase 1: Insert nodes WITHOUT self-referencing FKs ──
    nodes_data = dump_data.get("nodes", [])
    logger.info(f"Importing {len(nodes_data)} nodes (phase 1: insert)")

    for node_data in nodes_data:
        old_id = node_data.get("id")
        if old_id is None:
            # v2 format: no integer id, we need to track by uuid
            continue

        node_uuid = map_uuid(node_data.get("uuid"))
        node_name = str(node_data.get("name", ""))

        # Remap UUIDs in node name (AST JSON with link_id references)
        if remap_uuids:
            node_name = _remap_uuids_in_text(node_name, uuid_map)

        row = await conn.fetchrow("""
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
            ) RETURNING id
        """,
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
            json.dumps(node_data.get("classes_path", []), default=str),
            _parse_datetime(node_data.get("open_date")),
            _parse_datetime(node_data.get("create_date")) or now,
            _parse_datetime(node_data.get("write_date")) or now,
            _to_bool(node_data.get("is_deleted", False)),
            _parse_datetime(node_data.get("deleted_at")),
            user_id,
        )

        if row:
            node_id_map[old_id] = row['id']
            stats["nodes"] += 1

    # ── Phase 2: Update nodes with self-referencing FKs ─────
    logger.info(f"Importing nodes (phase 2: update references)")

    for node_data in nodes_data:
        old_id = node_data.get("id")
        if old_id is None or old_id not in node_id_map:
            continue

        new_id = node_id_map[old_id]

        parent_id = None
        if node_data.get("parent_id") is not None:
            parent_id = node_id_map.get(int(node_data["parent_id"]))

        page_id = None
        if node_data.get("page_id") is not None:
            page_id = node_id_map.get(int(node_data["page_id"]))

        aliased_id = None
        if node_data.get("aliased_id") is not None:
            aliased_id = node_id_map.get(int(node_data["aliased_id"]))

        # Remap class_ids (integer array of class node IDs)
        class_ids = _remap_int_list(
            node_data.get("class_ids", []), node_id_map
        )

        # Remap classes_path JSONB (may contain integer IDs)
        classes_path = node_data.get("classes_path", [])
        if isinstance(classes_path, list):
            classes_path = _remap_int_list(classes_path, node_id_map)

        # Only update if there's something to set
        if parent_id or page_id or aliased_id or class_ids:
            await conn.execute("""
                UPDATE node
                SET parent_id = $1, page_id = $2, aliased_id = $3,
                    class_ids = $4, classes_path = $5::jsonb
                WHERE id = $6
            """,
                parent_id, page_id, aliased_id,
                class_ids if class_ids else [],
                json.dumps(classes_path if classes_path else []),
                new_id,
            )

    # ── Phase 3: Insert properties ──────────────────────────
    properties_data = dump_data.get("properties", [])
    logger.info(f"Importing {len(properties_data)} properties")

    for prop_data in properties_data:
        old_id = prop_data.get("id")
        if old_id is None:
            continue

        prop_uuid = map_uuid(prop_data.get("uuid"))

        # Local properties reference a node
        prop_node_id = None
        if prop_data.get("node_id") is not None:
            prop_node_id = node_id_map.get(int(prop_data["node_id"]))

        row = await conn.fetchrow("""
            INSERT INTO property (
                uuid, workspace_id, name, icon, type, is_multi, is_system,
                is_local, node_id, icon_visibility, active,
                create_date, write_date, create_uid, write_uid
            ) VALUES (
                $1::uuid, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11,
                $12, $13, $14, $14
            ) RETURNING id
        """,
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

        if row:
            property_id_map[old_id] = row['id']
            stats["properties"] += 1

    # ── Phase 4: Insert property selection lines ────────────
    sel_lines_data = dump_data.get("property_selection_lines", [])
    logger.info(f"Importing {len(sel_lines_data)} property selection lines")

    for sl_data in sel_lines_data:
        old_id = sl_data.get("id")
        if old_id is None:
            continue

        prop_id = property_id_map.get(int(sl_data["property_id"]))
        if prop_id is None:
            logger.warning(
                f"Skipping selection line {old_id}: "
                f"property {sl_data['property_id']} not found in map"
            )
            continue

        sl_uuid = map_uuid(sl_data.get("uuid"))

        row = await conn.fetchrow("""
            INSERT INTO property_selection_line (
                uuid, property_id, name, icon, create_date, write_date,
                create_uid, write_uid
            ) VALUES (
                $1::uuid, $2, $3, $4, $5, $6, $7, $7
            ) RETURNING id
        """,
            sl_uuid,
            prop_id,
            str(sl_data.get("name", "")),
            sl_data.get("icon"),
            _parse_datetime(sl_data.get("create_date")) or now,
            _parse_datetime(sl_data.get("write_date")) or now,
            user_id,
        )

        if row:
            selection_line_id_map[old_id] = row['id']
            stats["property_selection_lines"] += 1

    # ── Phase 5: Insert property class filters ──────────────
    pcf_data = dump_data.get("property_class_filters", [])
    logger.info(f"Importing {len(pcf_data)} property class filters")

    for pcf in pcf_data:
        prop_id = property_id_map.get(int(pcf["property_id"]))
        class_node_id = node_id_map.get(int(pcf["class_node_id"]))

        if prop_id is None or class_node_id is None:
            logger.warning(
                f"Skipping property class filter: "
                f"property {pcf['property_id']} or class {pcf['class_node_id']} not found"
            )
            continue

        await conn.execute("""
            INSERT INTO property_class_filter (property_id, class_node_id)
            VALUES ($1, $2)
            ON CONFLICT (property_id, class_node_id) DO NOTHING
        """, prop_id, class_node_id)

        stats["property_class_filters"] += 1

    # ── Phase 6: Insert node properties ─────────────────────
    np_data = dump_data.get("node_properties", [])
    logger.info(f"Importing {len(np_data)} node properties")

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

        row = await conn.fetchrow("""
            INSERT INTO node_property (
                uuid, node_id, property_id, create_date, write_date,
                create_uid, write_uid
            ) VALUES (
                $1::uuid, $2, $3, $4, $5, $6, $6
            ) RETURNING id
        """,
            np_uuid,
            n_id,
            p_id,
            _parse_datetime(np_item.get("create_date")) or now,
            _parse_datetime(np_item.get("write_date")) or now,
            user_id,
        )

        if row:
            node_property_id_map[old_id] = row['id']
            stats["node_properties"] += 1

    # ── Phase 7: Insert property value scalars ──────────────
    pvs_data = dump_data.get("property_value_scalars", [])
    logger.info(f"Importing {len(pvs_data)} property value scalars")

    for pvs in pvs_data:
        np_id = node_property_id_map.get(int(pvs["node_property_id"]))
        p_id = property_id_map.get(int(pvs["property_id"]))
        n_id = node_id_map.get(int(pvs["node_id"]))

        if np_id is None or p_id is None or n_id is None:
            logger.warning(f"Skipping property_value_scalar: missing FK mapping")
            continue

        pvs_uuid = map_uuid(pvs.get("uuid"))

        # Remap UUIDs in value_text if applicable
        value_text = pvs.get("value_text")
        if remap_uuids and value_text:
            value_text = _remap_uuids_in_text(str(value_text), uuid_map)

        await conn.execute("""
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
            pvs_uuid,
            np_id, p_id, n_id,
            value_text,
            _to_bool(pvs.get("value_boolean")),
            float(pvs["value_float"]) if pvs.get("value_float") is not None else None,
            _to_int(pvs.get("value_integer")),
            _parse_datetime(pvs.get("create_date")) or now,
            _parse_datetime(pvs.get("write_date")) or now,
            user_id,
        )
        stats["property_values"] += 1

    # ── Phase 8: Insert property value relations ────────────
    pvr_data = dump_data.get("property_value_relations", [])
    logger.info(f"Importing {len(pvr_data)} property value relations")

    for pvr in pvr_data:
        np_id = node_property_id_map.get(int(pvr["node_property_id"]))
        p_id = property_id_map.get(int(pvr["property_id"]))
        n_id = node_id_map.get(int(pvr["node_id"]))
        t_id = node_id_map.get(int(pvr["target_id"]))

        if np_id is None or p_id is None or n_id is None or t_id is None:
            logger.warning(f"Skipping property_value_relation: missing FK mapping")
            continue

        pvr_uuid = map_uuid(pvr.get("uuid"))

        await conn.execute("""
            INSERT INTO property_value_relation (
                uuid, node_property_id, property_id, node_id, target_id,
                "order", create_date, write_date, create_uid, write_uid
            ) VALUES (
                $1::uuid, $2, $3, $4, $5,
                $6, $7, $8, $9, $9
            )
        """,
            pvr_uuid,
            np_id, p_id, n_id, t_id,
            _to_int(pvr.get("order", 0)),
            _parse_datetime(pvr.get("create_date")) or now,
            _parse_datetime(pvr.get("write_date")) or now,
            user_id,
        )
        stats["property_values"] += 1

    # ── Phase 9: Insert property value selections ───────────
    pvsel_data = dump_data.get("property_value_selections", [])
    logger.info(f"Importing {len(pvsel_data)} property value selections")

    for pvsel in pvsel_data:
        np_id = node_property_id_map.get(int(pvsel["node_property_id"]))
        p_id = property_id_map.get(int(pvsel["property_id"]))
        n_id = node_id_map.get(int(pvsel["node_id"]))
        sl_id = selection_line_id_map.get(int(pvsel["selection_line_id"]))

        if np_id is None or p_id is None or n_id is None or sl_id is None:
            logger.warning(f"Skipping property_value_selection: missing FK mapping")
            continue

        pvsel_uuid = map_uuid(pvsel.get("uuid"))

        await conn.execute("""
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
            pvsel_uuid,
            np_id, p_id, n_id,
            sl_id,
            _parse_datetime(pvsel.get("create_date")) or now,
            _parse_datetime(pvsel.get("write_date")) or now,
            user_id,
        )
        stats["property_values"] += 1

    # ── Phase 10: Insert class extends ──────────────────────
    ce_data = dump_data.get("class_extends", [])
    logger.info(f"Importing {len(ce_data)} class extends")

    for ce in ce_data:
        target = node_id_map.get(int(ce["target_id"]))
        source = node_id_map.get(int(ce["source_id"]))

        if target is None or source is None:
            logger.warning(f"Skipping class_extend: missing node mapping")
            continue

        await conn.execute("""
            INSERT INTO class_extend (target_id, source_id, sequence)
            VALUES ($1, $2, $3)
            ON CONFLICT (target_id, source_id) DO NOTHING
        """, target, source, _to_int(ce.get("sequence", 0)))

        stats["class_extends"] += 1

    # ── Phase 11: Insert class properties ───────────────────
    cp_data = dump_data.get("class_properties", [])
    logger.info(f"Importing {len(cp_data)} class properties")

    for cp in cp_data:
        class_n_id = node_id_map.get(int(cp["class_node_id"]))
        p_id = property_id_map.get(int(cp["property_id"]))

        if class_n_id is None or p_id is None:
            logger.warning(f"Skipping class_property: missing mapping")
            continue

        default_node_id = None
        if cp.get("default_node_id") is not None:
            default_node_id = node_id_map.get(int(cp["default_node_id"]))

        default_sel_id = None
        if cp.get("default_selection_id") is not None:
            default_sel_id = selection_line_id_map.get(
                int(cp["default_selection_id"])
            )

        await conn.execute("""
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
            class_n_id, p_id,
            _to_int(cp.get("sequence", 0)),
            _to_bool(cp.get("hidden", False)),
            _to_int(cp.get("default_integer")),
            float(cp["default_float"]) if cp.get("default_float") is not None else None,
            cp.get("default_text"),
            _to_bool(cp.get("default_boolean")),
            default_node_id,
            default_sel_id,
        )

        stats["class_properties"] += 1

    # ── Phase 12: Insert node links ─────────────────────────
    links_data = dump_data.get("links", [])
    logger.info(f"Importing {len(links_data)} node links")

    for link_data in links_data:
        source = node_id_map.get(int(link_data["source_id"]))
        target = node_id_map.get(int(link_data["target_id"]))

        if source is None or target is None:
            logger.warning(
                f"Skipping node_link: source {link_data['source_id']} "
                f"or target {link_data['target_id']} not found"
            )
            continue

        link_uuid = map_uuid(link_data.get("uuid"))

        # Optional property reference
        link_property_id = None
        if link_data.get("property_id") is not None:
            link_property_id = property_id_map.get(int(link_data["property_id"]))

        # Remap UUIDs in link name if present
        link_name = link_data.get("name")
        if remap_uuids and link_name:
            link_name = _remap_uuids_in_text(str(link_name), uuid_map)

        await conn.execute("""
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
            link_uuid,
            source, target, workspace_id, link_property_id,
            _to_int(link_data.get("position", 0)),
            _to_bool(link_data.get("is_tag", False)),
            _to_bool(link_data.get("is_inline_class", False)),
            link_name,
            _parse_datetime(link_data.get("create_date")) or now,
            user_id,
        )

        stats["links"] += 1

    # ── Phase 13: Insert node views ─────────────────────────
    nv_data = dump_data.get("node_views", [])
    logger.info(f"Importing {len(nv_data)} node views")

    for nv in nv_data:
        nv_node_id = node_id_map.get(int(nv["node_id"]))
        if nv_node_id is None:
            logger.warning(f"Skipping node_view: node {nv['node_id']} not found")
            continue

        nv_uuid = map_uuid(nv.get("uuid"))

        # Remap UUIDs in query_json and shown_properties
        query_json = nv.get("query_json", {})
        shown_properties = nv.get("shown_properties", [])
        group_by = nv.get("group_by")

        if remap_uuids:
            query_json = _remap_uuids_in_jsonb(query_json, uuid_map)
            shown_properties = _remap_uuids_in_jsonb(shown_properties, uuid_map)
            if group_by and UUID_PATTERN.match(group_by):
                group_by = uuid_map.get(group_by.lower(), group_by)

        await conn.execute("""
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
        """,
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

        stats["node_views"] += 1

    # ── Phase 14: Insert workspace settings ─────────────────
    settings_data = dump_data.get("settings", [])
    logger.info(f"Importing {len(settings_data)} workspace settings")

    for setting in settings_data:
        setting_value = setting.get("value")
        if remap_uuids and setting_value:
            setting_value = _remap_uuids_in_jsonb(setting_value, uuid_map)

        await conn.execute("""
            INSERT INTO setting_workspace (workspace_id, key, value,
                                           create_date, write_date,
                                           create_uid, write_uid)
            VALUES ($1, $2, $3::jsonb, $4, $4, $5, $5)
            ON CONFLICT (workspace_id, key) DO UPDATE
                SET value = EXCLUDED.value, write_date = EXCLUDED.write_date
        """,
            workspace_id,
            str(setting["key"]),
            json.dumps(setting_value, default=str) if setting_value is not None else None,
            now,
            user_id,
        )
        stats["settings"] += 1

    # ── Phase 15: Rebuild node_path closure table ───────────
    logger.info("Rebuilding node_path closure table")
    await conn.execute("SELECT rebuild_node_path()")

    logger.info(f"Import complete: {stats}")
    return stats


# ============================================================
# IMPORT TO NEW WORKSPACE
# ============================================================

async def import_dump_to_new_workspace(
    user_id_str: str,
    dump_data: dict,
    workspace_name: str,
) -> Dict[str, Any]:
    """Import a dump file into a brand new workspace with remapped UUIDs.

    Creates a new workspace (without default seeding), generates new UUIDs
    for every entity, and writes all data with the new identity.

    Args:
        user_id_str: User ID string
        dump_data: Parsed dump JSON
        workspace_name: Name for the new workspace

    Returns:
        Dict with workspace info and import stats
    """
    from .database import _get_numeric_user_id, _active_workspaces

    numeric_user_id = await _get_numeric_user_id(user_id_str)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id_str}")

    async with get_connection() as conn:
        # Check name uniqueness
        existing = await conn.fetchrow(
            "SELECT id FROM workspace WHERE create_uid = $1 AND name = $2 AND active = TRUE",
            numeric_user_id, workspace_name,
        )
        if existing:
            raise ValueError(f"Workspace '{workspace_name}' already exists")

        # Create workspace record (NO seeding - we'll fill from dump)
        async with conn.transaction():
            ws_row = await conn.fetchrow("""
                INSERT INTO workspace (name, create_uid, write_uid, is_shared, active)
                VALUES ($1, $2, $2, FALSE, TRUE)
                RETURNING id, uuid, name, create_date
            """, workspace_name, numeric_user_id)

            if ws_row is None:
                raise RuntimeError("Failed to create workspace")

            workspace_id = ws_row['id']
            workspace_uuid = str(ws_row['uuid'])

            logger.info(
                f"Created workspace '{workspace_name}' (id={workspace_id}, "
                f"uuid={workspace_uuid}) for import"
            )

            # Run the core import with UUID remapping
            stats = await _import_dump_core(
                conn, dump_data, workspace_id, numeric_user_id,
                remap_uuids=True,
            )

        # Activate the new workspace
        _active_workspaces[user_id_str] = workspace_uuid

        return {
            "uuid": workspace_uuid,
            "name": workspace_name,
            "created_at": ws_row['create_date'].isoformat() if ws_row['create_date'] else None,
            "stats": stats,
        }


# ============================================================
# RESTORE WORKSPACE FROM DUMP
# ============================================================

async def restore_workspace_from_dump(
    user_id_str: str,
    workspace_uuid: str,
    dump_data: dict,
) -> Dict[str, Any]:
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
    from .database import _get_numeric_user_id

    numeric_user_id = await _get_numeric_user_id(user_id_str)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id_str}")

    async with get_connection() as conn:
        # Find workspace
        ws_row = await conn.fetchrow("""
            SELECT g.id, g.uuid, g.name FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.uuid::text = $1 AND g.active = TRUE
              AND (g.create_uid = $2 OR gs.user_id = $2)
        """, workspace_uuid, numeric_user_id)

        if not ws_row:
            raise ValueError(f"Workspace '{workspace_uuid}' not found")

        workspace_id = ws_row['id']

        async with conn.transaction():
            # Delete all existing data in the workspace
            # Order matters for FK constraints (or rely on CASCADE)
            logger.warning(
                f"Restoring workspace '{ws_row['name']}' (id={workspace_id}) "
                f"- DELETING ALL EXISTING DATA"
            )

            # node_view, node_link, property values, node_property,
            # class_property, class_extend, property_class_filter,
            # property_selection_line, property, node
            # Most of these cascade from node and property deletes

            # Delete node views (references nodes)
            await conn.execute("""
                DELETE FROM node_view
                WHERE node_id IN (SELECT id FROM node WHERE workspace_id = $1)
            """, workspace_id)

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
            stats = await _import_dump_core(
                conn, dump_data, workspace_id, numeric_user_id,
                remap_uuids=False,
            )

        return {
            "uuid": str(ws_row['uuid']),
            "name": ws_row['name'],
            "stats": stats,
        }


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
    from .database import _get_numeric_user_id

    numeric_user_id = await _get_numeric_user_id(user_id_str)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id_str}")

    async with get_connection() as conn:
        # Find workspace
        workspace = await conn.fetchrow("""
            SELECT g.id, g.uuid, g.name
            FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.name = $2 AND g.active = TRUE
              AND (g.create_uid = $1 OR gs.user_id = $1)
        """, numeric_user_id, workspace_name)

        if not workspace:
            raise ValueError(f"Workspace '{workspace_name}' not found")

        workspace_id = workspace['id']
        workspace_uuid = str(workspace['uuid'])

        # Create full dump
        dump_data = await export_workspace_full(conn, workspace_id)

    # Write to file
    export_dir = DATA_DIR / "workspaces" / workspace_uuid / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    export_path = export_dir / f"{workspace_name}_dump.json"

    with open(export_path, 'w', encoding='utf-8') as f:
        json.dump(dump_data, f, default=str, indent=2)

    file_size_mb = export_path.stat().st_size / (1024 * 1024)
    logger.info(
        f"Exported workspace '{workspace_name}' to {export_path} "
        f"({file_size_mb:.2f} MB)"
    )

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
    from .database import _get_numeric_user_id

    numeric_user_id = await _get_numeric_user_id(user_id_str)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id_str}")

    async with get_connection() as conn:
        workspace = await conn.fetchrow("""
            SELECT g.id, g.uuid, g.name
            FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.uuid::text = $2 AND g.active = TRUE
              AND (g.create_uid = $1 OR gs.user_id = $1)
        """, numeric_user_id, workspace_uuid)

        if not workspace:
            raise ValueError(f"Workspace '{workspace_uuid}' not found")

        workspace_id = workspace['id']
        ws_name = workspace['name']

        dump_data = await export_workspace_full(conn, workspace_id)

    export_dir = DATA_DIR / "workspaces" / workspace_uuid / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    export_path = export_dir / f"{ws_name}_dump.json"

    with open(export_path, 'w', encoding='utf-8') as f:
        json.dump(dump_data, f, default=str, indent=2)

    return export_path
