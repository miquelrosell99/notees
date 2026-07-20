"""Unit tests for operation payload validation."""

from __future__ import annotations

import pytest

from app.core.clock import Hlc
from app.core.operation import Operation, OperationEnvelope
from app.core.validation import validate_operation, validate_payload

pytestmark = pytest.mark.unit


def _make_operation(op_type: str, payload: dict) -> Operation:
    return Operation(
        envelope=OperationEnvelope(
            workspace_id="ws-1",
            actor_id="actor-1",
            hlc=Hlc(physical=1, logical=0),
            op_type=op_type,
        ),
        payload=payload,
    )


class TestValidatePayload:
    def test_valid_node_create_payload(self) -> None:
        error = validate_payload(
            "node.create", {"nodeId": "n-1", "kind": "page", "index": 0}
        )
        assert error is None

    def test_node_create_missing_required_field(self) -> None:
        error = validate_payload("node.create", {"nodeId": "n-1", "kind": "page"})
        assert error is not None
        assert "index" in error

    def test_unknown_op_type(self) -> None:
        error = validate_payload("node.unknown", {"nodeId": "n-1"})
        assert error is not None
        assert "Unknown op_type" in error

    def test_non_dict_payload(self) -> None:
        error = validate_payload("node.delete", "not-a-dict")
        assert error is not None

    def test_null_required_field(self) -> None:
        error = validate_payload("node.delete", {"nodeId": None})
        assert error is not None

    @pytest.mark.parametrize(
        "payload",
        [
            {"nodeId": "n-1", "crdtUpdate": [{"type": "text", "text": "hi"}]},
            {"nodeId": "n-1", "textUpdate": [1, 2, 3]},
            {"nodeId": "n-1", "content": [{"type": "text", "text": "hi"}]},
            {"nodeId": "n-1", "treeUpdate": [1, 2, 3]},
        ],
    )
    def test_valid_node_update_content_payloads(self, payload: dict) -> None:
        assert validate_payload("node.updateContent", payload) is None

    def test_node_update_content_missing_update_key(self) -> None:
        error = validate_payload("node.updateContent", {"nodeId": "n-1"})
        assert error is not None
        assert "crdtUpdate" in error

    def test_node_update_content_missing_node_id(self) -> None:
        error = validate_payload("node.updateContent", {"crdtUpdate": []})
        assert error is not None
        assert "nodeId" in error


class TestValidateOperation:
    def test_valid_operation(self) -> None:
        op = _make_operation(
            "property.set",
            {
                "propertyValueId": "pv-1",
                "nodeId": "n-1",
                "schemaId": "s-1",
                "index": 0,
                "value": "hello",
            },
        )
        assert validate_operation(op) is None

    def test_missing_workspace_id(self) -> None:
        op = Operation(
            envelope=OperationEnvelope(
                workspace_id="",
                actor_id="actor-1",
                hlc=Hlc(physical=1, logical=0),
                op_type="node.delete",
            ),
            payload={"nodeId": "n-1"},
        )
        error = validate_operation(op)
        assert error is not None
        assert "workspace_id" in error

    def test_negative_hlc(self) -> None:
        op = Operation(
            envelope=OperationEnvelope(
                workspace_id="ws-1",
                actor_id="actor-1",
                hlc=Hlc(physical=-1, logical=0),
                op_type="node.delete",
            ),
            payload={"nodeId": "n-1"},
        )
        error = validate_operation(op)
        assert error is not None
        assert "HLC" in error
