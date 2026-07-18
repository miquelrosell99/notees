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
