"""Minimal cryptographic helpers for the encrypted operation relay.

These helpers mirror the prototype key derivation and AES-GCM encryption used
by ``frontend/src/core/crypto.ts`` so that server-side seeding produces
envelopes the frontend can decrypt. Phase 5 will replace this ad-hoc scheme
with a real key-management system.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

_SALT = b"notees-ideal-prototype-salt"
_ITERATIONS = 100_000


def derive_workspace_key(workspace_id: str, secret_key: str) -> bytes:
    """Derive a 32-byte AES key from a workspace id and the app secret key.

    This mirrors the client-side ``deriveKey`` implementation in
    ``frontend/src/core/crypto.ts``: PBKDF2-HMAC-SHA256 with a fixed salt and
    100,000 iterations. The password is ``{workspace_id}:{secret_key}`` so the
    key is workspace-specific.

    Args:
        workspace_id: Public workspace UUID.
        secret_key: The application's ``SECRET_KEY`` setting.

    Returns:
        32 raw key bytes suitable for AES-256-GCM.
    """
    password = f"{workspace_id}:{secret_key}".encode()
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_SALT,
        iterations=_ITERATIONS,
    )
    return kdf.derive(password)


def derive_user_wrapping_key(user_id: str, secret_key: str) -> bytes:
    """Derive a 32-byte AES wrapping key for a user from the app secret key.

    Uses the same PBKDF2-HMAC-SHA256 parameters as :func:`derive_workspace_key`
    but with the password ``{user_id}:{secret_key}``. This is a *prototype*
    server-side key-derivation scheme; Phase 6 should move to true client-side
    key generation for full E2EE.

    Args:
        user_id: Public user UUID.
        secret_key: The application's ``SECRET_KEY`` setting.

    Returns:
        32 raw key bytes suitable for AES-256-GCM.
    """
    password = f"{user_id}:{secret_key}".encode()
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_SALT,
        iterations=_ITERATIONS,
    )
    return kdf.derive(password)


def wrap_key(key: bytes, wrapping_key: bytes) -> dict[str, str]:
    """Wrap ``key`` with ``wrapping_key`` using AES-256-GCM.

    Returns a dictionary with ``ciphertext`` and ``iv`` as base64 strings.
    This is a *prototype* server-side wrapping scheme; Phase 6 should move to
    true client-side key generation for full E2EE.
    """
    aes = AESGCM(wrapping_key)
    iv = os.urandom(12)
    ciphertext = aes.encrypt(iv, key, None)
    return {
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        "iv": base64.b64encode(iv).decode("ascii"),
    }


def unwrap_key(wrapped: dict[str, str], wrapping_key: bytes) -> bytes:
    """Unwrap a key produced by :func:`wrap_key`.

    Args:
        wrapped: Dictionary with ``ciphertext`` and ``iv`` as base64 strings.
        wrapping_key: The 32-byte AES key used to wrap the key.

    Returns:
        The original raw key bytes.

    Raises:
        ValueError: If the ciphertext is malformed or authentication fails.
    """
    try:
        ciphertext = base64.b64decode(wrapped["ciphertext"])
        iv = base64.b64decode(wrapped["iv"])
    except (KeyError, ValueError) as exc:
        raise ValueError("Invalid wrapped key format") from exc

    aes = AESGCM(wrapping_key)
    try:
        return aes.decrypt(iv, ciphertext, None)
    except Exception as exc:
        raise ValueError("Failed to unwrap key") from exc


def encrypt_operation_payload(payload: dict[str, Any], key: bytes) -> dict[str, Any]:
    """Encrypt a JSON operation payload with AES-GCM.

    Returns a dictionary with ``ciphertext`` and ``iv`` as base64 strings,
    matching the wire format expected by the relay and the frontend
    ``EncryptedEnvelope`` type.
    """
    aes = AESGCM(key)
    iv = os.urandom(12)
    plaintext = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ciphertext = aes.encrypt(iv, plaintext, None)
    return {
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        "iv": base64.b64encode(iv).decode("ascii"),
    }


def decrypt_operation_payload(ciphertext_b64: str, iv_b64: str, key: bytes) -> dict[str, Any]:
    """Decrypt an AES-GCM operation payload produced by :func:`encrypt_operation_payload`.

    Args:
        ciphertext_b64: Base64-encoded ciphertext.
        iv_b64: Base64-encoded 12-byte IV.
        key: 32-byte AES key.

    Returns:
        The decrypted JSON payload as a Python dictionary.

    Raises:
        ValueError: If the ciphertext or IV is malformed or authentication fails.
    """
    try:
        ciphertext = base64.b64decode(ciphertext_b64)
        iv = base64.b64decode(iv_b64)
    except (KeyError, ValueError) as exc:
        raise ValueError("Invalid envelope encoding") from exc

    aes = AESGCM(key)
    try:
        plaintext = aes.decrypt(iv, ciphertext, None)
    except Exception as exc:
        raise ValueError("Failed to decrypt operation payload") from exc

    return json.loads(plaintext.decode("utf-8"))
