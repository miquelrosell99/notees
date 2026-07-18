"""Pydantic request/response models for the encrypted operation relay."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, field_validator

from app.core.clock import Hlc
from app.core.operation import OperationEnvelope


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
    """

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


class CatchUpRequest(BaseModel):
    """Request all operations for a workspace newer than the given HLC."""

    workspace_id: str
    hlc: Hlc

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
