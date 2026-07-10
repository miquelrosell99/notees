"""Password hashing and verification utilities."""

from __future__ import annotations

from passlib.context import CryptContext

from ..logging_config import get_logger

logger = get_logger(__name__)

# Password hashing context.
# Primary: bcrypt (recommended by the security-hardening skill).
# pbkdf2_sha256 is retained only for legacy-hash verification; new hashes
# always use bcrypt. Legacy users are transparently re-hashed on next login.
pwd_context = CryptContext(
    schemes=["bcrypt", "pbkdf2_sha256"],
    deprecated="auto",
)


def hash_password(password: str) -> str:
    """Hash a password with the primary scheme (bcrypt)."""
    return pwd_context.hash(password)


class PasswordVerificationError(Exception):
    """Raised when a password cannot be verified due to a technical fault.

    This signals a server/infrastructure problem (for example a malformed
    stored hash, an unknown hashing scheme, or a hashing backend failure) and
    must never be treated as a wrong password. A genuine password mismatch is
    reported as ``False`` and is not raised.
    """


def verify_password(password: str, hashed: str) -> bool:
    """Verify a password against its hash.

    Supports both bcrypt (current) and legacy pbkdf2_sha256 hashes.

    Returns ``False`` for a genuine password mismatch. Technical faults that
    prevent verification from being performed at all raise
    :class:`PasswordVerificationError` so callers can surface a temporary
    outage instead of silently locking users out with a misleading
    "invalid password" response.

    Raises:
        PasswordVerificationError: If verification cannot be performed due to a
            malformed hash, unknown scheme, or hashing backend error.
    """
    try:
        return pwd_context.verify(password, hashed)
    except Exception as e:
        logger.error(f"Password verification failed for technical reasons: {e}")
        raise PasswordVerificationError("Unable to verify password due to a server error") from e


def password_needs_rehash(hashed: str) -> bool:
    """Return True if the stored hash uses a deprecated/legacy scheme."""
    try:
        return pwd_context.identify(hashed, required=False) != "bcrypt"
    except Exception:
        return True
