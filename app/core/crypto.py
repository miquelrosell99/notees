"""Legacy cryptographic helpers from the encrypted-relay prototype phase.

Operation payloads are no longer encrypted per-envelope — relay payloads are
plaintext JSON and confidentiality comes from transport encryption
(TLS/Tailscale). The helpers below are kept for legacy callers; see
:func:`decrypt_payload`, which is now a pass-through.
"""

from __future__ import annotations

import base64
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


def encrypt_operation_payload(
    payload: dict[str, Any], key: bytes | None = None
) -> dict[str, Any]:
    """Pass-through for legacy compatibility.

    Operation payloads are now transported as plaintext JSON inside the
    envelope; transport-layer encryption provides confidentiality. The ``key``
    argument is accepted but ignored so existing callers do not all have to
    change.
    """
    return payload


def decrypt_operation_payload(
    envelope: dict[str, Any], key: bytes | None = None
) -> dict[str, Any]:
    """Return the plaintext payload from an envelope.

    Operation payloads are no longer encrypted per-envelope; this helper is kept
    as a pass-through for legacy callers. The ``key`` argument is accepted but
    ignored.
    """
    return envelope["payload"]
