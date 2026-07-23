"""Seed new workspaces into the operation-log relay.

This module replaces the legacy PostgreSQL-only workspace seeding for the data
that the local-first frontend needs. It writes the canonical system classes and
default pages as encrypted operations through the shared relay storage adapter,
so every client that catches up the workspace will derive the same state.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

from app.core.clock import Clock
from app.core.operation import Operation, OperationEnvelope
from app.core.uuid import uuidv7
from app.domain.entities.constants import (
    SYSTEM_CLASS_UUIDS,
    SYSTEM_PAGE_UUIDS,
)
from app.relay.models import EncryptedEnvelope


def _name_ast(text: str) -> list[dict[str, Any]]:
    """Return a minimal paragraph AST for a plain-text node name."""
    return [
        {
            "type": "paragraph",
            "children": [{"type": "text", "text": text}],
        }
    ]


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


def _class_operations(
    clock: Clock,
    workspace_id: str,
    actor_id: str,
) -> list[Operation]:
    """Operations that create every system class and tag it as class+page."""
    class_class = SYSTEM_CLASS_UUIDS["class"]
    page_class = SYSTEM_CLASS_UUIDS["page"]
    operations: list[Operation] = []

    for class_name, class_uuid in SYSTEM_CLASS_UUIDS.items():
        operations.append(
            _build_operation(
                clock,
                workspace_id,
                actor_id,
                "class.create",
                {"classId": class_uuid, "name": class_name},
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
        for target_class in {class_class, page_class}:
            operations.append(
                _build_operation(
                    clock,
                    workspace_id,
                    actor_id,
                    "class.assign",
                    {"nodeId": class_uuid, "classId": target_class},
                    [class_uuid],
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
    page_class = SYSTEM_CLASS_UUIDS["page"]
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
                    "classIds": [page_class],
                    "initialContent": _name_ast(name),
                },
                [page_uuid],
            )
        )

    return operations


async def _save_envelopes(
    storage: Any,
    envelopes: list[EncryptedEnvelope],
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
    """Seed a workspace's system classes and default pages into the relay.

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
    operations.extend(_page_operations(clock, workspace_id, actor_id, user_display_name))

    envelopes: list[EncryptedEnvelope] = []
    for operation in operations:
        envelopes.append(
            EncryptedEnvelope(
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
