"""TOTP two-factor authentication helpers.

Implements RFC 6238 TOTP enrollment/verification, encrypted-at-rest secret
storage, QR provisioning, and one-time backup codes. No network access is
required: code generation and verification are purely local computations from a
shared secret and the current time.

The TOTP secret and QR are never written to disk or logs; the plaintext secret
is only ever returned to the client once, during enrollment.
"""

from __future__ import annotations

import base64
import hashlib
import io
import secrets

import pyotp
import qrcode
import qrcode.image.svg
from cryptography.fernet import Fernet

from app.config import settings
from app.logging_config import get_logger
from app.utils.password import pwd_context

logger = get_logger(__name__)

ISSUER = "Notees"
TOTP_DIGITS = 6
TOTP_INTERVAL = 30
TOTP_VALID_WINDOW = 1  # accept +/- 1 step (+/- 30s) to absorb clock drift
BACKUP_CODE_COUNT = 10

_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
    """Return a Fernet keyed deterministically from the instance SECRET_KEY."""
    global _fernet
    if _fernet is None:
        digest = hashlib.sha256(settings.secret_key.encode("utf-8")).digest()
        key = base64.urlsafe_b64encode(digest)
        _fernet = Fernet(key)
    return _fernet


def generate_secret() -> str:
    """Generate a new random base32 TOTP secret."""
    return pyotp.random_base32()


def provisioning_uri(secret: str, email: str, issuer: str = ISSUER) -> str:
    """Build the otpauth:// URI encoded in the enrollment QR."""
    totp = pyotp.TOTP(secret, digits=TOTP_DIGITS, interval=TOTP_INTERVAL)
    return totp.provisioning_uri(name=email, issuer_name=issuer)


def verify_code(secret: str, code: str) -> bool:
    """Verify a 6-digit TOTP code against a secret (with clock-drift window).

    Returns False on a mismatch or any technical problem; never raises, so a
    malformed input cannot be mistaken for anything other than a failed attempt.
    """
    if not secret or not code:
        return False
    normalized = code.strip().replace(" ", "")
    if not normalized.isdigit():
        return False
    totp = pyotp.TOTP(secret, digits=TOTP_DIGITS, interval=TOTP_INTERVAL)
    try:
        return bool(totp.verify(normalized, valid_window=TOTP_VALID_WINDOW))
    except Exception as e:
        logger.error(f"TOTP verification technical failure: {e}")
        return False


def encrypt_secret(plaintext: str) -> str:
    """Encrypt a TOTP secret for storage at rest."""
    return _get_fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_secret(token: str) -> str:
    """Decrypt a stored TOTP secret."""
    return _get_fernet().decrypt(token.encode("utf-8")).decode("utf-8")


def generate_qr_svg(uri: str) -> str:
    """Render an otpauth:// URI as an SVG QR code string (in memory only)."""
    img = qrcode.make(uri, image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue().decode("utf-8")


def generate_backup_codes(count: int = BACKUP_CODE_COUNT) -> list[str]:
    """Generate one-time backup codes formatted as xxxx-xxxx."""
    codes: list[str] = []
    for _ in range(count):
        raw = secrets.token_hex(4)  # 8 hex chars
        codes.append(f"{raw[:4]}-{raw[4:]}")
    return codes


def _normalize_backup_code(code: str) -> str:
    return code.strip().replace("-", "").replace(" ", "").lower()


def hash_backup_code(code: str) -> str:
    """Hash a backup code for storage (uses the app's password hash context)."""
    return pwd_context.hash(_normalize_backup_code(code))


def verify_backup_code(code: str, hashed: str) -> bool:
    """Verify a backup code against its stored hash; never raises."""
    try:
        return pwd_context.verify(_normalize_backup_code(code), hashed)
    except Exception:
        return False
