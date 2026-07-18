"""Pydantic request/response models for workspace key management."""

from __future__ import annotations

from pydantic import BaseModel, Field


class KeyResponse(BaseModel):
    """Wrapped workspace key returned to a member."""

    workspace_id: str
    user_id: str
    ciphertext: str = Field(description="Base64 AES-GCM ciphertext of the workspace master key")
    iv: str = Field(description="Base64 AES-GCM IV used for the ciphertext")
    key_version: int = Field(description="Version of the workspace master key")


class InviteKeyRequest(BaseModel):
    """Request to generate or retrieve a wrapped key for a target user."""

    target_user_id: str = Field(description="Public UUID of the user to invite/provision")


class RotateKeyRequest(BaseModel):
    """Request to rotate the workspace master key.

    The body is intentionally empty; the workspace is identified by the path.
    """

    pass


class RotateKeyResponse(BaseModel):
    """Result of a successful workspace key rotation."""

    workspace_id: str
    key_version: int
