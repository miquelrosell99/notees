"""
Domain DTOs for the v2 optimistic vector-clock sync protocol.

These models define the contract between the sync server and any client
(web, Flutter, desktop). They are transport-agnostic and live in the domain
layer so the v2 sync service can be tested without FastAPI imports.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

#: Version vector for a single node: {client_id: seq}.
VersionVector = dict[str, int]

#: Base vector for a batch: {node_uuid: VersionVector}.
BaseVector = dict[str, VersionVector]


class OperationIntent(BaseModel):
    """A single client operation sent to the sync server.

    The `type` discriminator determines which payload fields are relevant.
    Unknown operation types are rejected by the server.
    """

    type: str = Field(
        ...,
        description=(
            "Operation type: create, update_content, move, delete, restore, "
            "add_class, remove_class, add_tag, remove_tag, update_node, set_property."
        ),
    )
    client_id: str = Field(..., description="Stable client/device UUID.")
    seq: int = Field(..., description="Monotonic client sequence number for this op.")
    node_uuid: str = Field(..., description="UUID of the target node.")
    # Tree / hierarchy
    parent_uuid: str | None = Field(None, description="New parent UUID for tree ops.")
    after_uuid: str | None = Field(None, description="Sibling to insert/move after.")
    # Content
    content_ast: list[dict[str, Any]] | None = Field(
        None, description="Full AST document for update_content ops."
    )
    name: str | None = Field(None, description="Plain-text name/title for update_node ops.")
    # Classes / tags
    class_uuid: str | None = Field(None, description="Class UUID for add_class/remove_class.")
    tag_uuid: str | None = Field(None, description="Tag UUID for add_tag/remove_tag.")
    class_uuids: list[str] | None = Field(None, description="Complete class list for set_classes.")
    tag_uuids: list[str] | None = Field(None, description="Complete tag list for set_tags.")
    # Node flags
    is_deleted: bool | None = Field(None, description="Soft-delete flag for delete/restore ops.")
    # Extra node properties (icon, color, etc.)
    properties: dict[str, Any] | None = Field(
        None, description="Arbitrary node property updates for update_node ops."
    )
    # Property value ops
    property_uuid: str | None = Field(
        None, description="Property UUID for set_property ops."
    )
    property_value: Any | None = Field(
        None, description="Property value for set_property ops."
    )
    # Node type flags for create ops
    is_page: bool = Field(False, description="Create as a page.")
    is_task: bool = Field(False, description="Create as a task item.")
    is_daily: bool = Field(False, description="Create as a daily journal page.")
    is_monthly: bool = Field(False, description="Create as a monthly journal page.")
    is_yearly: bool = Field(False, description="Create as a yearly journal page.")


class SyncBatchRequest(BaseModel):
    """Request body for POST /sync/batch."""

    ops: list[OperationIntent] = Field(
        ..., description="Client operations to apply.", max_length=100
    )
    base_vector: BaseVector = Field(
        ...,
        description=(
            "Last server-confirmed version vector per affected node. "
            "Must NOT include optimistic local increments."
        ),
    )
    workspace_uuid: str | None = Field(
        None, description="Target workspace UUID; defaults to the user's active workspace."
    )


class SyncBatchResponse(BaseModel):
    """Successful response from POST /sync/batch."""

    applied: bool = True
    new_vectors: BaseVector = Field(
        ..., description="Updated version vectors for all nodes touched by the batch."
    )


class SyncConflictResponse(BaseModel):
    """409 response from POST /sync/batch when one or more nodes are stale."""

    stale_nodes: list[str] = Field(
        ..., description="Node UUIDs whose base vector did not match the server."
    )
    server_vectors: BaseVector = Field(
        ..., description="Current server vectors for the stale nodes."
    )
    conflict_type: str = Field(
        ...,
        description=(
            "Broad conflict category: text_edit, tree_conflict, "
            "permission_denied, node_deleted."
        ),
    )


class AppliedOperation(BaseModel):
    """An operation that was applied on the server, broadcast to other clients."""

    type: str
    node_uuid: str
    client_id: str
    seq: int
    parent_uuid: str | None = None
    after_uuid: str | None = None
