"""Utilities for building workspace import record bundles."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from app.domain.entities import generate_uuid

from ..logging_config import get_logger

logger = get_logger(__name__)

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


def _sanitize_filename(name: str) -> str:
    """Sanitize a string for use as a filename."""
    return re.sub(r"[^\w\-_.]", "_", name).strip("_") or "untitled"


def _build_uuid_map(dump_data: dict, remap_uuids: bool) -> dict[str, str]:
    """Build a map of old UUIDs to new UUIDs when remapping is enabled."""
    uuid_map: dict[str, str] = {}
    if not remap_uuids:
        return uuid_map

    for node in dump_data.get("nodes", []):
        old = str(node["uuid"]).lower()
        uuid_map[old] = generate_uuid()

    for link in dump_data.get("links", []):
        old = str(link["uuid"]).lower()
        uuid_map[old] = generate_uuid()

    for prop in dump_data.get("properties", []):
        old = str(prop["uuid"]).lower()
        uuid_map[old] = generate_uuid()

    for sl in dump_data.get("property_selection_lines", []):
        if "uuid" in sl:
            old = str(sl["uuid"]).lower()
            uuid_map[old] = generate_uuid()

    for np in dump_data.get("node_properties", []):
        if "uuid" in np:
            old = str(np["uuid"]).lower()
            uuid_map[old] = generate_uuid()

    for vs in dump_data.get("property_value_scalars", []):
        if "uuid" in vs:
            old = str(vs["uuid"]).lower()
            uuid_map[old] = generate_uuid()

    for vr in dump_data.get("property_value_relations", []):
        if "uuid" in vr:
            old = str(vr["uuid"]).lower()
            uuid_map[old] = generate_uuid()

    for vsel in dump_data.get("property_value_selections", []):
        if "uuid" in vsel:
            old = str(vsel["uuid"]).lower()
            uuid_map[old] = generate_uuid()

    for nv in dump_data.get("node_views", []):
        if "uuid" in nv:
            old = str(nv["uuid"]).lower()
            uuid_map[old] = generate_uuid()

    ws_uuid = str(dump_data.get("workspace", {}).get("uuid", "")).lower()
    if ws_uuid:
        uuid_map[ws_uuid] = generate_uuid()

    logger.info(f"UUID remap: {len(uuid_map)} UUIDs will be remapped")
    return uuid_map


@dataclass
class ImportRecordBundle:
    """Pre-computed record lists used during a bulk import."""

    workspace_id: int
    user_id: int
    now: datetime
    remap_uuids: bool
    uuid_map: dict[str, str]

    # Phase 1: nodes
    node_records: list[tuple[Any, ...]] = field(default_factory=list)
    node_uuid_to_old_id: dict[str, int] = field(default_factory=dict)

    # Phase 2: node reference updates
    node_update_records: list[tuple[Any, ...]] = field(default_factory=list)

    # Phase 3: properties
    property_records: list[tuple[Any, ...]] = field(default_factory=list)
    property_uuid_to_old_id: dict[str, int] = field(default_factory=dict)

    # Phase 4: selection lines
    selection_line_records: list[tuple[Any, ...]] = field(default_factory=list)
    selection_line_uuid_to_old_id: dict[str, int] = field(default_factory=dict)

    # Phase 5: property class filters
    class_filter_records: list[tuple[Any, ...]] = field(default_factory=list)

    # Phase 6: node properties
    node_property_records: list[tuple[Any, ...]] = field(default_factory=list)
    node_property_uuid_to_old_id: dict[str, int] = field(default_factory=dict)

    # Phase 7-9: property values
    scalar_value_records: list[tuple[Any, ...]] = field(default_factory=list)
    relation_value_records: list[tuple[Any, ...]] = field(default_factory=list)
    selection_value_records: list[tuple[Any, ...]] = field(default_factory=list)

    # Phase 10-11: class extends / class properties
    class_extend_records: list[tuple[Any, ...]] = field(default_factory=list)
    class_property_records: list[tuple[Any, ...]] = field(default_factory=list)

    # Phase 12: links
    link_records: list[tuple[Any, ...]] = field(default_factory=list)
    tag_links_by_source: dict[int, set[int]] = field(default_factory=dict)

    # Phase 13-14: views / settings
    node_view_records: list[tuple[Any, ...]] = field(default_factory=list)
    settings_records: list[tuple[Any, ...]] = field(default_factory=list)


def build_import_records(
    dump_data: dict,
    workspace_id: int,
    user_id: int,
    remap_uuids: bool,
    node_id_map: dict[int, int] | None = None,
    property_id_map: dict[int, int] | None = None,
    selection_line_id_map: dict[int, int] | None = None,
    node_property_id_map: dict[int, int] | None = None,
    now: datetime | None = None,
) -> ImportRecordBundle:
    """Build all SQL record lists for a bulk import.

    The bundle is built in phases. ID maps for earlier phases must be supplied
    to build records for later phases. Repository implementations call this
    repeatedly as they obtain ID maps from the database.
    """
    if now is None:
        now = datetime.now(UTC)
    uuid_map = _build_uuid_map(dump_data, remap_uuids)

    def map_uuid(old_val: Any) -> str:
        if old_val is None:
            return generate_uuid()
        s = str(old_val).lower()
        return uuid_map.get(s, str(old_val))

    bundle = ImportRecordBundle(
        workspace_id=workspace_id,
        user_id=user_id,
        now=now,
        remap_uuids=remap_uuids,
        uuid_map=uuid_map,
    )

    # Phase 1: nodes
    for node_data in dump_data.get("nodes", []):
        old_id = node_data.get("id")
        if old_id is None:
            continue

        node_uuid = map_uuid(node_data.get("uuid"))
        node_name = str(node_data.get("name", ""))
        if remap_uuids:
            node_name = _remap_uuids_in_text(node_name, uuid_map)

        bundle.node_uuid_to_old_id[node_uuid.lower()] = old_id
        bundle.node_records.append(
            (
                node_uuid,
                workspace_id,
                node_name,
                node_data.get("icon"),
                node_data.get("color"),
                _to_int(node_data.get("sequence", 0)),
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
                _ensure_list(node_data.get("classes_path", [])),
                _ensure_list(node_data.get("tag_ids", [])),
                _parse_datetime(node_data.get("open_date")),
                _parse_datetime(node_data.get("create_date")) or now,
                _parse_datetime(node_data.get("write_date")) or now,
                _to_bool(node_data.get("is_deleted", False)),
                _parse_datetime(node_data.get("deleted_at")),
                user_id,
            )
        )

    if node_id_map is None:
        return bundle

    # Phase 2: node reference updates
    for node_data in dump_data.get("nodes", []):
        old_id = node_data.get("id")
        if old_id is None or old_id not in node_id_map:
            continue

        new_id = node_id_map[old_id]
        parent_id = node_id_map.get(int(node_data["parent_id"])) if node_data.get("parent_id") is not None else None
        page_id = node_id_map.get(int(node_data["page_id"])) if node_data.get("page_id") is not None else None
        aliased_id = node_id_map.get(int(node_data["aliased_id"])) if node_data.get("aliased_id") is not None else None
        class_ids = _remap_int_list(node_data.get("class_ids", []), node_id_map)
        tag_ids = _remap_int_list(node_data.get("tag_ids", []), node_id_map)
        classes_path = node_data.get("classes_path", [])
        if isinstance(classes_path, list):
            classes_path = _remap_int_list(classes_path, node_id_map)

        if aliased_id is not None and aliased_id == new_id:
            logger.warning(
                f"Skipping self-referencing alias for node {new_id} "
                f"(original id {old_id})"
            )
            aliased_id = None

        if parent_id or page_id or aliased_id or class_ids or tag_ids:
            bundle.node_update_records.append(
                (
                    parent_id,
                    page_id,
                    aliased_id,
                    class_ids if class_ids else [],
                    tag_ids if tag_ids else [],
                    _ensure_list(classes_path),
                    new_id,
                )
            )

    # Phase 3: properties
    for prop_data in dump_data.get("properties", []):
        old_id = prop_data.get("id")
        if old_id is None:
            continue

        prop_uuid = map_uuid(prop_data.get("uuid"))
        prop_node_id = None
        if prop_data.get("node_id") is not None:
            prop_node_id = node_id_map.get(int(prop_data["node_id"]))

        scope = prop_data.get("scope")
        if scope is None:
            scope = "node" if _to_bool(prop_data.get("is_local", False)) else "global"

        bundle.property_uuid_to_old_id[prop_uuid.lower()] = old_id
        bundle.property_records.append(
            (
                prop_uuid,
                workspace_id,
                str(prop_data.get("name", "")),
                prop_data.get("icon"),
                str(prop_data.get("type", "text")),
                _to_bool(prop_data.get("is_multi", False)),
                _to_bool(prop_data.get("is_system", False)),
                str(scope),
                prop_node_id,
                prop_data.get("icon_visibility", "hidden"),
                _to_bool(prop_data.get("active", True)),
                _parse_datetime(prop_data.get("create_date")) or now,
                _parse_datetime(prop_data.get("write_date")) or now,
                user_id,
            )
        )

    if property_id_map is None:
        return bundle

    # Phase 5: property class filters
    for pcf in dump_data.get("property_class_filters", []):
        prop_id = property_id_map.get(int(pcf["property_id"]))
        class_node_id = node_id_map.get(int(pcf["class_node_id"]))

        if prop_id is None or class_node_id is None:
            logger.warning(
                f"Skipping property class filter: "
                f"property {pcf['property_id']} or class {pcf['class_node_id']} not found"
            )
            continue

        bundle.class_filter_records.append((prop_id, class_node_id))

    # Phase 4: selection lines
    for sl_data in dump_data.get("property_selection_lines", []):
        old_id = sl_data.get("id")
        if old_id is None:
            continue

        prop_id = property_id_map.get(int(sl_data["property_id"]))
        if prop_id is None:
            logger.warning(f"Skipping selection line {old_id}: property {sl_data['property_id']} not found in map")
            continue

        sl_uuid = map_uuid(sl_data.get("uuid"))
        bundle.selection_line_uuid_to_old_id[sl_uuid.lower()] = old_id
        bundle.selection_line_records.append(
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

    if selection_line_id_map is None:
        return bundle

    # Phase 6: node properties
    for np_item in dump_data.get("node_properties", []):
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
        bundle.node_property_uuid_to_old_id[np_uuid.lower()] = old_id
        bundle.node_property_records.append(
            (
                np_uuid,
                n_id,
                p_id,
                _parse_datetime(np_item.get("create_date")) or now,
                _parse_datetime(np_item.get("write_date")) or now,
                user_id,
            )
        )

    if node_property_id_map is None:
        return bundle

    # Phase 7: scalar values
    for pvs in dump_data.get("property_value_scalars", []):
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

        bundle.scalar_value_records.append(
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

    # Phase 8: relation values
    for pvr in dump_data.get("property_value_relations", []):
        np_id = node_property_id_map.get(int(pvr["node_property_id"]))
        p_id = property_id_map.get(int(pvr["property_id"]))
        n_id = node_id_map.get(int(pvr["node_id"]))
        t_id = node_id_map.get(int(pvr["target_id"]))

        if np_id is None or p_id is None or n_id is None or t_id is None:
            logger.warning("Skipping property_value_relation: missing FK mapping")
            continue

        pvr_uuid = map_uuid(pvr.get("uuid"))
        bundle.relation_value_records.append(
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

    # Phase 9: selection values
    for pvsel in dump_data.get("property_value_selections", []):
        np_id = node_property_id_map.get(int(pvsel["node_property_id"]))
        p_id = property_id_map.get(int(pvsel["property_id"]))
        n_id = node_id_map.get(int(pvsel["node_id"]))
        sl_id = selection_line_id_map.get(int(pvsel["selection_line_id"]))

        if np_id is None or p_id is None or n_id is None or sl_id is None:
            logger.warning("Skipping property_value_selection: missing FK mapping")
            continue

        pvsel_uuid = map_uuid(pvsel.get("uuid"))
        bundle.selection_value_records.append(
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

    # Phase 10: class extends
    for ce in dump_data.get("class_extends", []):
        target = node_id_map.get(int(ce["target_id"]))
        source = node_id_map.get(int(ce["source_id"]))

        if target is None or source is None:
            logger.warning("Skipping class_extend: missing node mapping")
            continue

        bundle.class_extend_records.append((target, source, _to_int(ce.get("sequence", 0))))

    # Phase 11: class properties
    for cp in dump_data.get("class_properties", []):
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

        bundle.class_property_records.append(
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

    # Phase 12: links
    for link_data in dump_data.get("links", []):
        source = node_id_map.get(int(link_data["source_id"]))
        target = node_id_map.get(int(link_data["target_id"]))

        if source is None or target is None:
            logger.warning(
                f"Skipping node_link: source {link_data['source_id']} or target {link_data['target_id']} not found"
            )
            continue

        if _to_bool(link_data.get("is_tag", False)):
            bundle.tag_links_by_source.setdefault(source, set()).add(target)
            continue

        link_uuid = map_uuid(link_data.get("uuid"))
        link_property_id = None
        if link_data.get("property_id") is not None:
            link_property_id = property_id_map.get(int(link_data["property_id"]))

        link_name = link_data.get("name")
        if remap_uuids and link_name:
            link_name = _remap_uuids_in_text(str(link_name), uuid_map)

        bundle.link_records.append(
            (
                link_uuid,
                source,
                target,
                workspace_id,
                link_property_id,
                _to_int(link_data.get("position", 0)),
                _to_bool(link_data.get("is_inline_class", False)),
                link_name,
                _parse_datetime(link_data.get("create_date")) or now,
                user_id,
            )
        )

    # Phase 13: node views
    for nv in dump_data.get("node_views", []):
        nv_node_id = node_id_map.get(int(nv["node_id"]))
        if nv_node_id is None:
            logger.warning(f"Skipping node_view: node {nv['node_id']} not found")
            continue

        nv_uuid = map_uuid(nv.get("uuid"))
        query_json = nv.get("query_json", {})
        shown_properties = nv.get("shown_properties", [])
        group_by = nv.get("group_by")
        sort_entries = nv.get("sort_entries", [])
        settings = nv.get("settings", {})

        if remap_uuids:
            query_json = _remap_uuids_in_jsonb(query_json, uuid_map)
            shown_properties = _remap_uuids_in_jsonb(shown_properties, uuid_map)
            # group_by is a JSONB string or list of strings (property UUIDs);
            # sort keys may be "property_<uuid>" — both are covered by the
            # text-level UUID remap over the JSON serialization.
            group_by = _remap_uuids_in_jsonb(group_by, uuid_map)
            sort_entries = _remap_uuids_in_jsonb(sort_entries, uuid_map)
            settings = _remap_uuids_in_jsonb(settings, uuid_map)

        bundle.node_view_records.append(
            (
                nv_uuid,
                nv_node_id,
                str(nv.get("name", "")),
                query_json,
                str(nv.get("view_type", "")),
                _to_int(nv.get("order_index", 0)),
                _to_bool(nv.get("is_default", False)),
                _to_bool(nv.get("active", True)),
                shown_properties,
                group_by,
                nv.get("view_mode"),
                sort_entries if isinstance(sort_entries, list) else [],
                settings if isinstance(settings, dict) else {},
                _parse_datetime(nv.get("create_date")) or now,
                _parse_datetime(nv.get("write_date")) or now,
                user_id,
            )
        )

    # Phase 14: settings
    for setting in dump_data.get("settings", []):
        setting_value = setting.get("value")
        if remap_uuids and setting_value:
            setting_value = _remap_uuids_in_jsonb(setting_value, uuid_map)

        bundle.settings_records.append(
            (
                workspace_id,
                str(setting["key"]),
                setting_value if setting_value is not None else None,
                now,
                user_id,
            )
        )

    return bundle
