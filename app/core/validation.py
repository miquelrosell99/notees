"""Basic operation payload validation.

Validates that an operation's payload contains the fields required by its
``op_type``. This is intentionally shallow: it checks structural presence, not
value semantics (those belong to CRDT appliers and derived-state builders).
"""

from __future__ import annotations

from typing import Any

from app.core.operation import KNOWN_OP_TYPES, Operation

# Required payload fields per operation type. Optional fields are omitted so
# that validation stays permissive; missing optional fields use defaults in
# the derived-state appliers.
REQUIRED_PAYLOAD_FIELDS: dict[str, frozenset[str]] = {
    "node.create": frozenset({"nodeId", "kind", "index"}),
    "node.delete": frozenset({"nodeId"}),
    "node.move": frozenset({"nodeId", "newParentId", "newIndex"}),
    "node.updateContent": frozenset({"nodeId", "crdtUpdate"}),
    "class.assign": frozenset({"nodeId", "classId"}),
    "class.unassign": frozenset({"nodeId", "classId"}),
    "property.set": frozenset({"propertyValueId", "nodeId", "schemaId", "index", "value"}),
    "property.unset": frozenset({"propertyValueId", "nodeId", "schemaId", "index"}),
    "propertySchema.create": frozenset({"schemaId", "name", "type", "config"}),
    "propertySchema.update": frozenset({"schemaId", "configDelta"}),
    "class.create": frozenset({"classId", "name", "propertySchemaIds", "extends"}),
    "class.update": frozenset({"classId"}),
}


def _validate_node_update_content(payload: dict[str, Any]) -> str | None:
    """``node.updateContent`` accepts one of several update payloads."""
    if "nodeId" not in payload:
        return "Missing required payload field(s) for node.updateContent: nodeId"
    if payload["nodeId"] is None:
        return "Required payload field 'nodeId' for node.updateContent cannot be null."

    if not any(key in payload for key in ("crdtUpdate", "textUpdate", "content", "treeUpdate")):
        return (
            "node.updateContent payload must include one of: "
            "crdtUpdate, textUpdate, content, treeUpdate"
        )

    return None


def validate_payload(op_type: str, payload: dict[str, Any]) -> str | None:
    """Validate payload structure for ``op_type``.

    Returns:
        ``None`` when the payload is valid, otherwise a human-readable error
        message describing the first missing or invalid field.
    """
    if op_type not in KNOWN_OP_TYPES:
        return f"Unknown op_type: {op_type!r}"

    if not isinstance(payload, dict):
        return "Payload must be an object/dictionary."

    if op_type == "node.updateContent":
        return _validate_node_update_content(payload)

    required = REQUIRED_PAYLOAD_FIELDS.get(op_type, frozenset())
    missing = sorted(required - payload.keys())
    if missing:
        return f"Missing required payload field(s) for {op_type}: {', '.join(missing)}"

    for key in required:
        if payload[key] is None:
            return f"Required payload field {key!r} for {op_type} cannot be null."

    return None


def validate_operation(operation: Operation) -> str | None:
    """Validate an operation's envelope and payload.

    Returns:
        ``None`` when the operation is structurally valid, otherwise a clear
        error message.
    """
    env = operation.envelope
    if not env.workspace_id:
        return "Operation envelope is missing workspace_id."
    if not env.actor_id:
        return "Operation envelope is missing actor_id."
    if env.hlc.physical < 0 or env.hlc.logical < 0:
        return "Operation HLC components must be non-negative."
    if env.op_type not in KNOWN_OP_TYPES:
        return f"Unknown op_type: {env.op_type!r}"

    return validate_payload(env.op_type, operation.payload)
