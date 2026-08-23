"""Seed new workspaces into the operation-log relay.

This module replaces the legacy PostgreSQL-only workspace seeding for the data
that the local-first frontend needs. It writes the canonical system classes
(with icons and ``extends`` edges), the class-scoped system property schemas
with their class bindings, and default pages as relay operations through the
shared relay storage adapter, so every client that catches up the workspace
will derive the same state.

It also provides :func:`ensure_system_schema`, the idempotent backfill that
brings pre-existing workspaces up to the current system schema on workspace
open. The mirrored frontend seed lives in ``frontend/src/core/seed.ts``; both
sides must emit equivalent operation sequences (seed parity contract).
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from app.core.clock import Clock
from app.core.operation import Operation, OperationEnvelope
from app.core.uuid import uuidv7
from app.domain.entities.constants import (
    SYSTEM_CLASS_EXTENDS,
    SYSTEM_CLASS_ICONS,
    SYSTEM_CLASS_UUIDS,
    SYSTEM_PAGE_UUIDS,
    SYSTEM_PROPERTY_SCHEMA_SPECS,
    SYSTEM_PROPERTY_UUIDS,
)
from app.relay.models import RelayEnvelope

if TYPE_CHECKING:
    from app.core.workspace_store import WorkspaceStore


def _name_ast(text: str) -> list[dict[str, Any]]:
    """Return a minimal paragraph AST for a plain-text node name."""
    return [
        {
            "type": "paragraph",
            "children": [{"type": "text", "text": text}],
        }
    ]


def _extends_uuids(class_name: str) -> list[str]:
    """Resolve the canonical extends parent UUIDs for a system class."""
    return [SYSTEM_CLASS_UUIDS[parent] for parent in SYSTEM_CLASS_EXTENDS.get(class_name, [])]


def _edge_sequences() -> dict[str, int]:
    """Per-class ``sequence`` of each schema's binding, in canonical spec order."""
    sequences: dict[str, int] = {}
    per_class: dict[str, int] = {}
    for schema_name, spec in SYSTEM_PROPERTY_SCHEMA_SPECS.items():
        class_name = spec["bindTo"]
        sequences[schema_name] = per_class.get(class_name, 0)
        per_class[class_name] = per_class.get(class_name, 0) + 1
    return sequences


def _schema_payload(schema_name: str, spec: dict[str, Any], schema_uuid: str) -> dict[str, Any]:
    """Build the ``propertySchema.create`` payload for a system schema."""
    payload: dict[str, Any] = {
        "schemaId": schema_uuid,
        "name": schema_name,
        "type": spec["type"],
        "isSystem": True,
        "scope": "class",
    }
    if spec.get("multi"):
        payload["multi"] = True
    if "classFilter" in spec:
        payload["classFilterUuids"] = [SYSTEM_CLASS_UUIDS[c] for c in spec["classFilter"]]
    if "options" in spec:
        payload["options"] = spec["options"]
    if "defaultValue" in spec:
        payload["defaultValue"] = spec["defaultValue"]
    return payload


def _build_operation(
    clock: Clock,
    workspace_id: str,
    actor_id: str,
    op_type: str,
    payload: dict[str, Any],
    affected_node_ids: list[str] | None = None,
) -> Operation:
    """Construct an operation with a fresh UUIDv7 id and HLC."""
    return Operation(
        envelope=OperationEnvelope(
            id=uuidv7(),
            workspace_id=workspace_id,
            actor_id=actor_id,
            hlc=clock.advance(int(datetime.now(UTC).timestamp() * 1000)),
            affected_node_ids=affected_node_ids or [],
            op_type=op_type,
        ),
        payload=payload,
    )


def _class_create_payload(class_name: str, class_uuid: str) -> dict[str, Any]:
    """Build the ``class.create`` payload for a system class."""
    payload: dict[str, Any] = {"classId": class_uuid, "name": class_name}
    icon = SYSTEM_CLASS_ICONS.get(class_name)
    if icon:
        payload["icon"] = icon
    extends = _extends_uuids(class_name)
    if extends:
        payload["extends"] = extends
    return payload


def _class_operations(
    clock: Clock,
    workspace_id: str,
    actor_id: str,
) -> list[Operation]:
    """Operations that create every system class.

    System classes are identified by kind='class' (via class.create); they do
    not need the meta "class" system class assigned to themselves. Classes
    with canonical ``extends`` parents are created after their parents (the
    UUID registry is ordered accordingly) so the derived hierarchy closure is
    complete from the start.
    """
    operations: list[Operation] = []

    for class_name, class_uuid in SYSTEM_CLASS_UUIDS.items():
        operations.append(
            _build_operation(
                clock,
                workspace_id,
                actor_id,
                "class.create",
                _class_create_payload(class_name, class_uuid),
                [class_uuid],
            )
        )
        operations.append(
            _build_operation(
                clock,
                workspace_id,
                actor_id,
                "node.updateContent",
                {"nodeId": class_uuid, "content": _name_ast(class_name)},
                [class_uuid],
            )
        )

    return operations


def _system_schema_operations(
    clock: Clock,
    workspace_id: str,
    actor_id: str,
) -> list[Operation]:
    """Operations that create the class-scoped system property schemas.

    Emits one ``propertySchema.create`` per system schema followed by the
    ``classPropertyEdge.create`` binding it to its owning class. Subclasses
    inherit the bindings through the class hierarchy closure.
    """
    operations: list[Operation] = []
    sequences = _edge_sequences()

    for schema_name, spec in SYSTEM_PROPERTY_SCHEMA_SPECS.items():
        schema_uuid = SYSTEM_PROPERTY_UUIDS[schema_name]
        operations.append(
            _build_operation(
                clock,
                workspace_id,
                actor_id,
                "propertySchema.create",
                _schema_payload(schema_name, spec, schema_uuid),
                [schema_uuid],
            )
        )
        class_uuid = SYSTEM_CLASS_UUIDS[spec["bindTo"]]
        operations.append(
            _build_operation(
                clock,
                workspace_id,
                actor_id,
                "classPropertyEdge.create",
                {
                    "classId": class_uuid,
                    "propertySchemaId": schema_uuid,
                    "sequence": sequences[schema_name],
                },
                [class_uuid, schema_uuid],
            )
        )

    return operations


def _page_operations(
    clock: Clock,
    workspace_id: str,
    actor_id: str,
    user_display_name: str,
) -> list[Operation]:
    """Operations that create default pages (Inbox and the user page)."""
    operations: list[Operation] = []

    pages = [
        ("Inbox", SYSTEM_PAGE_UUIDS["inbox"]),
        (user_display_name, SYSTEM_PAGE_UUIDS["scratchpad"]),
    ]

    for name, page_uuid in pages:
        operations.append(
            _build_operation(
                clock,
                workspace_id,
                actor_id,
                "node.create",
                {
                    "nodeId": page_uuid,
                    "kind": "page",
                    "initialContent": _name_ast(name),
                },
                [page_uuid],
            )
        )

    return operations


async def _save_envelopes(
    storage: Any,
    envelopes: list[RelayEnvelope],
) -> None:
    """Persist envelopes, awaiting the call if the adapter is async."""
    coro_or_result = storage.save_envelopes(envelopes)
    if asyncio.iscoroutine(coro_or_result):
        await coro_or_result
    # The return value (list of inserted ids) is intentionally ignored here.


async def seed_workspace_relay(
    workspace_id: str,
    actor_id: str,
    user_display_name: str,
) -> None:
    """Seed a workspace's system classes, schemas, and default pages into the relay.

    Args:
        workspace_id: Workspace UUID (the operation-log authority id).
        actor_id: Actor id to stamp on seed operations (normally the owner's
            user UUID).
        user_display_name: Display name for the user's personal page.
    """
    # Imported locally to avoid a circular import at module load time:
    # app.features.workspaces.service -> app.core.seed -> app.relay.dependencies
    # -> app.dependencies -> app.features.workspaces.service.
    from app.relay.dependencies import get_relay_storage

    storage = get_relay_storage()

    clock = Clock(device_id=actor_id)
    operations = _class_operations(clock, workspace_id, actor_id)
    operations.extend(_system_schema_operations(clock, workspace_id, actor_id))
    operations.extend(_page_operations(clock, workspace_id, actor_id, user_display_name))

    envelopes: list[RelayEnvelope] = []
    for operation in operations:
        envelopes.append(
            RelayEnvelope(
                id=operation.id,
                workspace_id=operation.envelope.workspace_id,
                actor_id=operation.envelope.actor_id,
                hlc=operation.envelope.hlc,
                affected_node_ids=operation.envelope.affected_node_ids,
                op_type=operation.envelope.op_type,
                payload=operation.payload,
                timestamp=operation.envelope.timestamp,
            )
        )

    await _save_envelopes(storage, envelopes)


async def ensure_system_schema(store: WorkspaceStore) -> int:
    """Backfill missing system schema into an existing workspace.

    Runs on workspace open so workspaces created before the source-hierarchy
    system schema existed receive it lazily. Only missing entities are
    emitted: absent classes (with icons and ``extends``), classes that exist
    but lack canonical ancestors (via ``class.setExtends`` with the union of
    existing and canonical parents), absent property schemas, and absent
    class-property bindings. All appliers involved are upsert-safe, so
    running this repeatedly converges without duplicates.

    Args:
        store: The workspace's server-side store (synced and used to emit).

    Returns:
        The number of operations emitted (0 when already up to date).
    """
    await store.sync()

    class_rows = await store.query("SELECT id, extends_class_ids, active FROM class")
    existing_extends: dict[str, list[str]] = {}
    for row in class_rows:
        if not row["active"]:
            continue
        raw = row["extends_class_ids"]
        try:
            parsed = json.loads(raw) if raw else []
        except json.JSONDecodeError:
            parsed = []
        existing_extends[row["id"]] = parsed if isinstance(parsed, list) else []

    schema_rows = await store.query("SELECT id FROM property_schema WHERE active = 1")
    existing_schemas = {row["id"] for row in schema_rows}

    edge_rows = await store.query("SELECT class_id, property_schema_id FROM class_property_edge")
    existing_edges = {(row["class_id"], row["property_schema_id"]) for row in edge_rows}

    emitted = 0

    for class_name, class_uuid in SYSTEM_CLASS_UUIDS.items():
        extends = _extends_uuids(class_name)
        if class_uuid not in existing_extends:
            await store.create_class(
                class_uuid,
                class_name,
                icon=SYSTEM_CLASS_ICONS.get(class_name),
                extends_class_ids=extends or None,
            )
            await store.update_content(class_uuid, _name_ast(class_name))
            emitted += 2
        elif extends:
            current = existing_extends[class_uuid]
            missing = [parent for parent in extends if parent not in current]
            if missing:
                await store.set_class_extends(class_uuid, [*current, *missing])
                emitted += 1

    sequences = _edge_sequences()
    for schema_name, spec in SYSTEM_PROPERTY_SCHEMA_SPECS.items():
        schema_uuid = SYSTEM_PROPERTY_UUIDS[schema_name]
        class_uuid = SYSTEM_CLASS_UUIDS[spec["bindTo"]]
        if schema_uuid not in existing_schemas:
            await store.create_property_schema(
                schema_uuid,
                schema_name,
                spec["type"],
                multi=bool(spec.get("multi")),
                is_system=True,
                scope="class",
                class_filter_uuids=(
                    [SYSTEM_CLASS_UUIDS[c] for c in spec["classFilter"]]
                    if "classFilter" in spec
                    else None
                ),
                options=spec.get("options"),
                default_value=spec.get("defaultValue"),
            )
            emitted += 1
        if (class_uuid, schema_uuid) not in existing_edges:
            await store.create_class_property_edge(
                class_uuid,
                schema_uuid,
                sequence=sequences[schema_name],
            )
            emitted += 1

    return emitted
