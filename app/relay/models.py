"""Pydantic request/response models for the encrypted operation relay."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator
from pydantic.alias_generators import to_camel

from app.core.clock import Hlc
from app.core.operation import OperationEnvelope

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
    """Routing metadata plus an encrypted operation payload.

    The envelope fields are inherited from :class:`app.core.operation.OperationEnvelope`
    so the server can validate ``op_type`` and HLC shape without decrypting the
    payload. The encrypted payload is split into base64 ``ciphertext`` and ``iv``
    to match the client-side AES-GCM wire format.

    The wire format uses camelCase keys to match the TypeScript client; the
    snake_case names remain valid for server-side callers and tests.
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    ciphertext: str
    iv: str

    @field_validator("hlc", mode="before")
    @classmethod
    def _validate_hlc(cls, value: Any) -> Hlc:
        hlc = _parse_hlc(value)
        if hlc.physical < 0 or hlc.logical < 0:
            raise ValueError("HLC components must be non-negative")
        return hlc


class BatchRequest(BaseModel):
    """A batch of encrypted operation envelopes submitted by a client."""

    envelopes: list[EncryptedEnvelope]

    @field_validator("envelopes")
    @classmethod
    def _validate_batch_size_and_envelope_sizes(
        cls, envelopes: list[EncryptedEnvelope]
    ) -> list[EncryptedEnvelope]:
        if len(envelopes) > MAX_BATCH_SIZE:
            raise ValueError(f"Batch exceeds maximum of {MAX_BATCH_SIZE} envelopes")
        for index, envelope in enumerate(envelopes):
            if len(envelope.ciphertext) > MAX_ENVELOPE_SIZE_BYTES:
                raise ValueError(
                    f"Envelope at index {index} exceeds maximum ciphertext size of {MAX_ENVELOPE_SIZE_BYTES} bytes"
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
    """A list of encrypted operation envelopes for catch-up sync."""

    envelopes: list[EncryptedEnvelope]


class CatchUpPaginatedResponse(BaseModel):
    """A paginated page of encrypted operation envelopes for catch-up sync."""

    envelopes: list[EncryptedEnvelope]
    next_after_id: str | None = None
    has_more: bool = False


class SnapshotRequest(BaseModel):
    """Request a snapshot up to a given HLC."""

    workspace_id: str
    up_to_hlc: Hlc

    @field_validator("up_to_hlc", mode="before")
    @classmethod
    def _validate_hlc(cls, value: Any) -> Hlc:
        hlc = _parse_hlc(value)
        if hlc.physical < 0 or hlc.logical < 0:
            raise ValueError("HLC components must be non-negative")
        return hlc


class SnapshotResponse(BaseModel):
    """Snapshot creation response."""

    snapshot_id: str
    workspace_id: str
    up_to_hlc: Hlc


class CompactRequest(BaseModel):
    """Request compaction of envelopes up to a given HLC."""

    workspace_id: str
    up_to_hlc: Hlc
    prune: bool = True

    @field_validator("up_to_hlc", mode="before")
    @classmethod
    def _validate_hlc(cls, value: Any) -> Hlc:
        hlc = _parse_hlc(value)
        if hlc.physical < 0 or hlc.logical < 0:
            raise ValueError("HLC components must be non-negative")
        return hlc


class CompactResponse(BaseModel):
    """Compaction response."""

    snapshot_id: str
    segment_id: str
    workspace_id: str
    up_to_hlc: Hlc
    operation_count: int
