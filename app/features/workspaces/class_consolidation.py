"""Opt-in class consolidation (Decision 26).

Merges a user-created class into another class (typically a system class)
given an **explicit** old→new class-UUID mapping provided by the user. The
mapping is never name-guessed: class names are free text in any language, so
equivalence is only ever asserted by the user.

For each pair the tool:

1. Reassigns every active node carrying the old class (``class.assign`` new +
   ``class.unassign`` old).
2. Remaps the old class's class-property edges onto the new class. When the
   bound schema's name matches a system property (e.g. a user schema named
   ``authors``), the edge is repointed to the system schema UUID and existing
   node property values are migrated to the system schema (set-if-absent,
   then unset the old value); otherwise the user's schema is re-bound as-is.
3. Soft-deletes the old class (``class.delete`` sets ``active = 0``).

The automatic system-schema backfill stays strictly additive and is not
affected by this tool.
"""

from __future__ import annotations

import json
from typing import Any

from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS

_SYSTEM_CLASS_UUID_SET = set(SYSTEM_CLASS_UUIDS.values())


class ConsolidationError(ValueError):
    """Raised when a consolidation request is invalid or refused."""


async def _get_class_row(store: WorkspaceStore, class_uuid: str) -> dict[str, Any] | None:
    rows = await store.query("SELECT id, name, active FROM class WHERE id = ?", (class_uuid,))
    return rows[0] if rows else None


async def consolidate_class(
    store: WorkspaceStore,
    *,
    old_class_uuid: str,
    new_class_uuid: str,
) -> dict[str, Any]:
    """Consolidate ``old_class_uuid`` into ``new_class_uuid``.

    Raises :class:`ConsolidationError` when the mapping is refused: identical
    classes, missing/inactive classes, or an attempt to consolidate away a
    system class.
    """
    if old_class_uuid == new_class_uuid:
        raise ConsolidationError("Old and new class must differ")

    old_row = await _get_class_row(store, old_class_uuid)
    if old_row is None or not old_row["active"]:
        raise ConsolidationError(f"Class '{old_class_uuid}' not found or inactive")
    if old_class_uuid in _SYSTEM_CLASS_UUID_SET:
        raise ConsolidationError(f"Refusing to consolidate system class '{old_row['name']}'")

    new_row = await _get_class_row(store, new_class_uuid)
    if new_row is None or not new_row["active"]:
        raise ConsolidationError(f"Class '{new_class_uuid}' not found or inactive")

    # 1. Reassign nodes.
    node_rows = await store.query("SELECT id, class_ids FROM node WHERE active = 1")
    nodes_reassigned = 0
    for row in node_rows:
        class_ids = set(json.loads(row["class_ids"]) or [])
        if old_class_uuid not in class_ids:
            continue
        if new_class_uuid not in class_ids:
            await store.assign_class(row["id"], new_class_uuid)
        await store.unassign_class(row["id"], old_class_uuid)
        nodes_reassigned += 1

    # 2. Remap class-property edges.
    edge_rows = await store.query(
        "SELECT property_schema_id, sequence FROM class_property_edge WHERE class_id = ?",
        (old_class_uuid,),
    )
    edges_remapped = 0
    values_migrated = 0
    for edge in edge_rows:
        schema_uuid = edge["property_schema_id"]
        schema_rows = await store.query("SELECT id, name FROM property_schema WHERE id = ?", (schema_uuid,))
        schema_name = (schema_rows[0]["name"] if schema_rows else "") or ""
        target_schema_uuid = SYSTEM_PROPERTY_UUIDS.get(schema_name.lower(), schema_uuid)

        if target_schema_uuid != schema_uuid:
            # Name matches a system property: migrate node values to the
            # system schema (set-if-absent, then unset the old value).
            value_rows = await store.query(
                "SELECT node_id, idx, value FROM property_value WHERE property_schema_id = ?",
                (schema_uuid,),
            )
            for value_row in value_rows:
                existing = await store.get_property(
                    node_id=value_row["node_id"],
                    schema_id=target_schema_uuid,
                    index=value_row["idx"],
                )
                if existing is None:
                    await store.set_property(
                        property_value_id=uuidv7(),
                        node_id=value_row["node_id"],
                        schema_id=target_schema_uuid,
                        value=json.loads(value_row["value"]),
                        index=value_row["idx"],
                    )
                await store.unset_property(value_row["node_id"], schema_uuid, index=value_row["idx"])
                values_migrated += 1

        existing_edge = await store.query(
            "SELECT 1 FROM class_property_edge WHERE class_id = ? AND property_schema_id = ?",
            (new_class_uuid, target_schema_uuid),
        )
        if not existing_edge:
            await store.create_class_property_edge(new_class_uuid, target_schema_uuid, sequence=edge["sequence"])
        edges_remapped += 1

    # 3. Soft-delete the old class.
    await store.delete_class(old_class_uuid)

    return {
        "old_class_uuid": old_class_uuid,
        "old_class_name": old_row["name"],
        "new_class_uuid": new_class_uuid,
        "new_class_name": new_row["name"],
        "nodes_reassigned": nodes_reassigned,
        "property_edges_remapped": edges_remapped,
        "property_values_migrated": values_migrated,
    }
