"""Unit tests for operation envelope and payload types."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.clock import Hlc
from app.core.operation import Operation, OperationEnvelope, create_operation

pytestmark = pytest.mark.unit


class TestOperationEnvelope:
    def test_create_envelope_with_all_fields(self) -> None:
        envelope = OperationEnvelope(
            id="op-1",
            workspace_id="ws-1",
            actor_id="actor-1",
            hlc=Hlc(physical=10, logical=0),
            affected_node_ids=["node-1"],
            op_type="node.create",
        )
        assert envelope.id == "op-1"
        assert envelope.workspace_id == "ws-1"
        assert envelope.affected_node_ids == ["node-1"]
        assert envelope.op_type == "node.create"

    def test_envelope_generates_id_and_timestamp_by_default(self) -> None:
        envelope = OperationEnvelope(
            workspace_id="ws-1",
            actor_id="actor-1",
            hlc=Hlc(physical=10, logical=0),
            op_type="node.create",
        )
        assert envelope.id
        assert envelope.timestamp

    def test_unknown_op_type_raises(self) -> None:
        with pytest.raises(ValidationError):
            OperationEnvelope(
                workspace_id="ws-1",
                actor_id="actor-1",
                hlc=Hlc(physical=10, logical=0),
                op_type="node.unknown",
            )


class TestOperation:
    def test_create_operation_helper(self) -> None:
        op = create_operation(
            envelope={
                "workspace_id": "ws-1",
                "actor_id": "actor-1",
                "hlc": Hlc(physical=10, logical=0),
                "op_type": "node.create",
            },
            payload={"nodeId": "node-1", "kind": "page", "index": 0},
        )
        assert op.envelope.workspace_id == "ws-1"
        assert op.payload["nodeId"] == "node-1"
        assert op.id == op.envelope.id
        assert op.hlc == op.envelope.hlc

    def test_operation_id_property(self) -> None:
        op = Operation(
            envelope=OperationEnvelope(
                id="op-1",
                workspace_id="ws-1",
                actor_id="actor-1",
                hlc=Hlc(physical=1, logical=0),
                op_type="node.delete",
            ),
            payload={"nodeId": "node-1"},
        )
        assert op.id == "op-1"
