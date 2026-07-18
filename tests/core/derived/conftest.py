"""Shared helpers for derived-state applier tests."""

from __future__ import annotations

from uuid import uuid4

import pytest

from app.core.clock import Hlc
from app.core.operation import Operation, OperationEnvelope

pytestmark = pytest.mark.unit


def make_operation(
    op_type: str,
    payload: dict,
    *,
    op_id: str | None = None,
    workspace_id: str = "ws-1",
    actor_id: str = "actor-1",
    physical: int = 1,
    logical: int = 0,
) -> Operation:
    return Operation(
        envelope=OperationEnvelope(
            id=op_id or uuid4().hex,
            workspace_id=workspace_id,
            actor_id=actor_id,
            hlc=Hlc(physical=physical, logical=logical),
            affected_node_ids=[
                payload.get(
                    "nodeId",
                    payload.get("classId", payload.get("shareId", "n-1")),
                )
            ],
            op_type=op_type,
        ),
        payload=payload,
    )
