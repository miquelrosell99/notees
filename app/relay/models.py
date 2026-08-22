"""Pydantic request/response models for the operation relay."""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator
from pydantic.alias_generators import to_camel

from app.core.clock import Hlc
from app.core.operation import PROTOCOL_VERSION, OperationEnvelope

__all__ = [
    "PROTOCOL_VERSION",
    "BatchRequest",
    "CatchUpPaginatedResponse",
    "CatchUpRequest",
    "CatchUpResponse",
    "CompactRequest",
    "CompactResponse",
    "EncryptedEnvelope",
    "LatestSnapshotResponse",
    "RelayStatsResponse",
    "SnapshotRequest",
    "SnapshotResponse",
]

MAX_BATCH_SIZE = 1000
MAX_ENVELOPE_SIZE_BYTES = 1024 * 1024  # 1 MB


def _parse_hlc(value: Any) -> Hlc:
    """Convert a dict or :class:`Hlc` into an ``Hlc`` instance.

    JSON requests represent HLCs as ``{"physical": int, "logical": int}``;
    Python callers can pass the dataclass directly.
    """
    if isinstance(value, Hlc):
        return value
    if isinstance(value, dict):
        return Hlc(physical=int(value["physical"]), logical=int(value["logical"]))
    raise ValueError(f"Invalid HLC value: {value!r}")


class EncryptedEnvelope(OperationEnvelope):
    """Routing metadata plus a plaintext operation payload.

    The envelope fields are inherited from :class:`app.core.operation.OperationEnvelope`
    so the server can route operations, enforce permissions, and serve catch-up
    queries without inspecting payload contents. The payload is stored as a JSON
    object; transport-layer encryption (TLS/Tailscale) provides confidentiality.

    The wire format uses camelCase keys to match the TypeScript client; the
    snake_case names remain valid for server-side callers and tests.
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    payload: dict[str, Any]

    @field_validator("hlc", mode="before")
    @classmethod
    def _validate_hlc(cls, value: Any) -> Hlc:
        hlc = _parse_hlc(value)
        if hlc.physical < 0 or hlc.logical < 0:
            raise ValueError("HLC components must be non-negative")
        return hlc


class BatchRequest(BaseModel):
    """A batch of operation envelopes submitted by a client."""

    envelopes: list[EncryptedEnvelope]

    @field_validator("envelopes")
    @classmethod
    def _validate_batch_size_and_envelope_sizes(
        cls, envelopes: list[EncryptedEnvelope]
    ) -> list[EncryptedEnvelope]:
        if len(envelopes) > MAX_BATCH_SIZE:
            raise ValueError(f"Batch exceeds maximum of {MAX_BATCH_SIZE} envelopes")
        for index, envelope in enumerate(envelopes):
            if len(json.dumps(envelope.payload)) > MAX_ENVELOPE_SIZE_BYTES:
                raise ValueError(
                    f"Envelope at index {index} exceeds maximum payload size of {MAX_ENVELOPE_SIZE_BYTES} bytes"
                )
        return envelopes


class CatchUpRequest(BaseModel):
    """Request operations for a workspace newer than the given HLC."""

    workspace_id: str
    hlc: Hlc
    limit: int = 1000
    after_id: str | None = None

    @field_validator("hlc", mode="before")
    @classmethod
    def _validate_hlc(cls, value: Any) -> Hlc:
        hlc = _parse_hlc(value)
        if hlc.physical < 0 or hlc.logical < 0:
            raise ValueError("HLC components must be non-negative")
        return hlc


class CatchUpResponse(BaseModel):
    """A list of operation envelopes for catch-up sync."""

    envelopes: list[EncryptedEnvelope]


class CatchUpPaginatedResponse(BaseModel):
    """A paginated page of operation envelopes for catch-up sync."""

    envelopes: list[EncryptedEnvelope]
    next_after_id: str | None = None
    has_more: bool = False
    restore_epoch: int = 0


class SnapshotRequest(BaseModel):
    """Request a snapshot up to a given HLC."""

    workspace_id: str
    up_to_hlc: Hlc
    data_base64: str = ""

    @field_validator("up_to_hlc", mode="before")
    @classmethod
    def _validate_hlc(cls, value: Any) -> Hlc:
        hlc = _parse_hlc(value)
        if hlc.physical < 0 or hlc.logical < 0:
            raise ValueError("HLC components must be non-negative")
        return hlc

    @property
    def data(self) -> bytes:
        import base64

        if not self.data_base64:
            return b""
        try:
            return base64.b64decode(self.data_base64)
        except Exception as exc:
            raise ValueError("Invalid base64 snapshot data") from exc


class SnapshotResponse(BaseModel):
    """Snapshot creation response."""

    snapshot_id: str
    workspace_id: str
    up_to_hlc: Hlc


class LatestSnapshotResponse(BaseModel):
    """Latest available snapshot for a workspace."""

    snapshot_id: str
    workspace_id: str
    hlc: Hlc
    data_base64: str
    has_snapshot: bool
    restore_epoch: int = 0


class CompactRequest(BaseModel):
    """Request compaction of envelopes up to a given HLC."""

    workspace_id: str
    up_to_hlc: Hlc
    prune: bool = True
    data_base64: str = ""

    @field_validator("up_to_hlc", mode="before")
    @classmethod
    def _validate_hlc(cls, value: Any) -> Hlc:
        hlc = _parse_hlc(value)
        if hlc.physical < 0 or hlc.logical < 0:
            raise ValueError("HLC components must be non-negative")
        return hlc

    @property
    def data(self) -> bytes:
        import base64

        if not self.data_base64:
            return b""
        try:
            return base64.b64decode(self.data_base64)
        except Exception as exc:
            raise ValueError("Invalid base64 snapshot data") from exc


class CompactResponse(BaseModel):
    """Compaction response."""

    snapshot_id: str
    segment_id: str
    workspace_id: str
    up_to_hlc: Hlc
    operation_count: int


class RelayStatsResponse(BaseModel):
    """Operational statistics for a workspace relay."""

    workspace_id: str
    envelope_count: int
    envelope_size_bytes: int
    snapshot_count: int
    latest_snapshot_hlc: Hlc | None = None
    compacted_segment_count: int
    compacted_operation_count: int
    max_hlc: Hlc
    restore_epoch: int = 0
