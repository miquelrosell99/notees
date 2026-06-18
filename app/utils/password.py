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


def verify_password(password: str, hashed: str) -> bool:
    """Verify a password against its hash.

    Supports both bcrypt (current) and legacy pbkdf2_sha256 hashes.
    """
    try:
        return pwd_context.verify(password, hashed)
    except Exception as e:
        logger.error(f"Password verification failed for technical reasons: {e}")
        return False


def password_needs_rehash(hashed: str) -> bool:
    """Return True if the stored hash uses a deprecated/legacy scheme."""
    try:
        return pwd_context.identify(hashed, required=False) != "bcrypt"
    except Exception:
        return True
