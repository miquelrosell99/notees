"""Operation envelope and payload types for the operation log.

Ports the TypeScript prototype in ``prototypes/notees-ideal-arch/src/operation.ts``
to Python, using Pydantic v2 for validation.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.core.clock import Hlc
from app.core.uuid import uuidv7

KNOWN_OP_TYPES: frozenset[str] = frozenset(
    [
        # Structural
        "node.create",
        "node.delete",
        "node.move",
        "node.updateContent",
        "class.assign",
        "class.unassign",
        # Properties
        "property.set",
        "property.unset",
        # Schema
        "propertySchema.create",
        "propertySchema.update",
        "propertySchema.delete",
        "classPropertyEdge.create",
        "classPropertyEdge.update",
        "classPropertyEdge.delete",
        "classPropertyEdge.reorder",
        "class.create",
        "class.update",
        # Tasks
        "task.recordCompletion",
        "task.deleteCompletion",
        "task.setRecurrence",
        "task.deleteRecurrence",
        # Assets
        "asset.upload",
        "asset.delete",
        # Activity
        "activity.record",
        "link.click",
        # Shares
        "share.public.create",
        "share.public.revoke",
        "share.user.grant",
        "share.user.revoke",
        # Plugins
        "plugin.op",
    ]
)


class OperationEnvelope(BaseModel):
    """Routing metadata for an operation.

    Envelope fields are unencrypted so the server can route operations, enforce
    permissions, and serve catch-up queries without accessing payload contents.
    """

    id: str = Field(default_factory=uuidv7)
    workspace_id: str
    actor_id: str
    hlc: Hlc
    affected_node_ids: list[str] = Field(default_factory=list)
    op_type: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("op_type")
    @classmethod
    def _validate_op_type(cls, value: str) -> str:
        if value not in KNOWN_OP_TYPES:
            raise ValueError(f"Unknown op_type: {value!r}")
        return value


class Operation(BaseModel):
    """A single operation: immutable routing envelope plus opaque payload."""

    envelope: OperationEnvelope
    payload: dict[str, Any]

    @property
    def id(self) -> str:
        return self.envelope.id

    @property
    def hlc(self) -> Hlc:
        return self.envelope.hlc


def create_operation(
    envelope: dict[str, Any],
    payload: dict[str, Any],
) -> Operation:
    """Build an :class:`Operation` from raw envelope fields and a payload.

    The envelope may omit ``id`` and ``timestamp``; defaults are generated
    automatically. This mirrors the prototype helper while staying explicit
    about required fields.
    """
    return Operation(envelope=OperationEnvelope(**envelope), payload=payload)
