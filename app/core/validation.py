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
    # Structural node operations
    "node.create": frozenset({"nodeId", "kind"}),
    "node.delete": frozenset({"nodeId"}),
    "node.move": frozenset({"nodeId"}),
    "node.updateContent": frozenset({"nodeId"}),
    "node.addAlias": frozenset({"canonicalNodeId", "aliasNodeId"}),
    "node.removeAlias": frozenset({"canonicalNodeId", "aliasNodeId"}),
    "node.archive": frozenset({"nodeId"}),
    "node.restore": frozenset({"nodeId"}),
    "node.permanentDelete": frozenset({"nodeId"}),
    "node.convert": frozenset({"nodeId", "kind"}),
    # Class membership
    "class.assign": frozenset({"nodeId", "classId"}),
    "class.unassign": frozenset({"nodeId", "classId"}),
    # Properties
    "property.set": frozenset({"propertyValueId", "nodeId", "schemaId", "value"}),
    "property.unset": frozenset({"nodeId", "schemaId"}),
    # Schema
    "propertySchema.create": frozenset({"schemaId", "name"}),
    "propertySchema.update": frozenset({"schemaId"}),
    "propertySchema.delete": frozenset({"schemaId"}),
    "classPropertyEdge.create": frozenset({"classId", "propertySchemaId"}),
    "classPropertyEdge.update": frozenset({"classId", "propertySchemaId"}),
    "classPropertyEdge.delete": frozenset({"classId", "propertySchemaId"}),
    "classPropertyEdge.reorder": frozenset({"classId", "orderedPropertySchemaIds"}),
    "class.create": frozenset({"classId", "name"}),
    "class.update": frozenset({"classId"}),
    "class.delete": frozenset({"classId"}),
    "class.setExtends": frozenset({"classId", "extendsClassIds"}),
    # Node views
    "nodeView.create": frozenset({"viewId", "nodeId", "name", "viewType"}),
    "nodeView.update": frozenset({"viewId"}),
    "nodeView.delete": frozenset({"viewId"}),
    "nodeView.reorder": frozenset({"nodeId", "viewType", "orderedViewIds"}),
    # Tasks
    "task.recordCompletion": frozenset({"nodeId"}),
    "task.deleteCompletion": frozenset({"nodeId", "completionId"}),
    "task.setRecurrence": frozenset({"nodeId", "rule"}),
    "task.deleteRecurrence": frozenset({"nodeId", "recurrenceId"}),
    # Assets
    "asset.upload": frozenset({"nodeId", "assetHash", "mimeType", "size", "originalName"}),
    "asset.delete": frozenset({"nodeId"}),
    # Activity / links / shares
    "activity.record": frozenset({"activityType"}),
    "activity.delete": frozenset({"activityId", "nodeId"}),
    "link.click": frozenset({"nodeId"}),
    "share.public.create": frozenset({"nodeId"}),
    "share.public.revoke": frozenset({"nodeId"}),
    "share.user.grant": frozenset({"nodeId", "userId", "role"}),
    "share.user.revoke": frozenset({"nodeId", "userId"}),
    # User preferences
    "user.favorite.add": frozenset({"nodeId"}),
    "user.favorite.remove": frozenset({"nodeId"}),
    "user.favorite.reorder": frozenset({"nodeIds"}),
    # Plugins
    "plugin.op": frozenset({"pluginId", "opType", "data"}),
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
