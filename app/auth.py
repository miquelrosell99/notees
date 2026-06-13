"""Authentication module for Notees.

Handles user authentication, JWT tokens, and password hashing.
User persistence is delegated to ``UserRepository``; this module keeps the
password/token cryptography and the in-memory user cache.
"""

from __future__ import annotations

import secrets
import string
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
from jwt import PyJWTError
from passlib.context import CryptContext

from .config import settings
from .db.connection import get_pool
from .domain.entities import User, UserCreateData
from .domain.repositories import PostgresUserRepository
from .domain.repositories.interfaces import UserRepository
from .logging_config import get_logger

logger = get_logger(__name__)

# In-memory user cache to avoid DB pool acquisition on every request
# Maps user_id (str) -> (user_dict, cached_at_timestamp)
_user_cache: dict[str, tuple[dict, float]] = {}
_USER_CACHE_TTL = 300  # 5 minutes


def clear_user_cache(user_id: str) -> None:
    """Invalidate the in-memory user cache for a single user."""
    _user_cache.pop(user_id, None)


async def _get_user_repo() -> UserRepository:
    """Return a UserRepository backed by the current pool."""
    return PostgresUserRepository(await get_pool())


def _user_to_dict(user: User, include_hash: bool = False) -> dict:
    """Convert a User entity to the dict shape used by API callers."""
    result = {
        "id": str(user.id) if user.id is not None else None,
        "uuid": user.uuid,
        "email": user.email,
        "name": user.name,
        "surnames": user.surnames,
        "profile_pic": user.profile_pic,
        "role": user.role,
        "is_active": user.active,
        "created_at": user.create_date,
    }
    if include_hash:
        result["hashed_password"] = user.password_hash
    return result


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


async def rehash_password(user_id: str | int, password: str) -> None:
    """Re-hash a user's password with the current primary scheme (bcrypt).

    Call this after a successful login when password_needs_rehash() is True.
    """
    repo = await _get_user_repo()
    new_hash = hash_password(password)
    await repo.update_password_hash(str(user_id), new_hash)
    clear_user_cache(str(user_id))


def create_token(user_id: str, email: str, role: str) -> str:
    """Create a JWT token."""
    expires_delta = timedelta(hours=settings.access_token_expire_hours)
    expire = datetime.now(UTC) + expires_delta

    payload = {"user_id": user_id, "email": email, "role": role, "exp": expire}

    token = jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)
    return token


def decode_token(token: str) -> dict | None:
    """Decode and verify a JWT token."""
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        return payload
    except PyJWTError as e:
        logger.warning(f"Token decode error: {e}")
        return None


async def get_user_by_id(user_id: str) -> dict | None:
    """Get a user by ID (numeric or UUID string).

    Uses an in-memory cache to avoid hitting the DB connection pool
    on every authenticated request.
    """
    now = time.monotonic()
    cached = _user_cache.get(user_id)
    if cached is not None:
        user_dict, cached_at = cached
        if now - cached_at < _USER_CACHE_TTL:
            return user_dict

    repo = await _get_user_repo()
    user = await repo.get_by_id_or_uuid(user_id)
    if user:
        result = _user_to_dict(user, include_hash=False)
        _user_cache[user_id] = (result, now)
        return result
    return None


async def get_user_by_email(email: str) -> dict | None:
    """Get a user by email, including the password hash for authentication."""
    repo = await _get_user_repo()
    user = await repo.get_by_email(email)
    if user:
        return _user_to_dict(user, include_hash=True)
    return None


async def create_user(
    email: str,
    password: str,
    name: str | None = None,
    surnames: str | None = None,
    profile_pic: str | None = None,
    role: str = "user",
) -> dict:
    """Create a new user."""
    repo = await _get_user_repo()
    existing = await repo.get_by_email(email)
    if existing:
        logger.warning("Attempted to create duplicate user")
        raise ValueError("Email already exists")

    hashed = hash_password(password)
    data = UserCreateData(
        email=email,
        password=password,
        name=name,
        surnames=surnames,
        profile_pic=profile_pic,
        role=role,
    )
    user = await repo.create(data, hashed)
    result = _user_to_dict(user, include_hash=False)
    logger.info(f"Created new user (user_id={result['id']}, role={role})")
    return result


async def update_user(user_id: str, **fields) -> dict | None:
    """Update a user's profile fields."""
    repo = await _get_user_repo()
    user = await repo.update_profile(
        user_id,
        name=fields.get("name"),
        surnames=fields.get("surnames"),
        profile_pic=fields.get("profile_pic"),
    )
    if user:
        clear_user_cache(user_id)
        return _user_to_dict(user, include_hash=False)
    return None


async def update_password(user_id: str, password: str) -> dict | None:
    """Update a user's password hash and invalidate the cached user record."""
    repo = await _get_user_repo()
    hashed = hash_password(password)
    user = await repo.update_password_hash(user_id, hashed)
    if user:
        clear_user_cache(user_id)
        return _user_to_dict(user, include_hash=False)
    return None


async def authenticate_user(email: str, password: str) -> dict | None:
    """Authenticate a user and return user data if valid."""
    user = await get_user_by_email(email)
    if not user:
        logger.warning("Authentication failed: user not found")
        return None

    verified = verify_password(password, user.get("hashed_password", ""))
    logger.debug(f"Authentication attempt (user_id={user['id']}): verified={bool(verified)}")
    if not verified:
        logger.warning(f"Authentication failed (user_id={user['id']}): invalid password")
        return None

    if not user.get("is_active", True):
        logger.warning(f"Authentication failed (user_id={user['id']}): account inactive")
        return None

    logger.info(f"Authentication successful (user_id={user.get('id')})")
    return user


async def is_first_boot() -> bool:
    """Check if the system has no users yet (first boot)."""
    repo = await _get_user_repo()
    return await repo.count_users() == 0


async def get_current_user_from_token(token: str) -> dict | None:
    """Get the current user from a token."""
    payload = decode_token(token)
    if not payload:
        return None

    user_id = payload.get("user_id")
    if not user_id:
        return None

    user = await get_user_by_id(user_id)
    if not user or not user.get("is_active", True):
        return None

    return user


def get_user_databases_dir(user_id: str) -> Path:
    """Get the databases directory for a user."""
    return Path(f"data/users/{user_id}/databases")


def get_user_export_dir(user_id: str) -> Path:
    """Get the export directory for a user."""
    return Path(f"data/users/{user_id}/export")


def get_user_backups_dir(user_id: str) -> Path:
    """Get the backups directory for a user."""
    return Path(f"data/users/{user_id}/backups")


# ─── API Key Management ───────────────────────────────────────────

_API_KEY_ALPHABET = string.ascii_letters + string.digits + "_-"
_API_KEY_PREFIX = "nk_"
_API_KEY_LENGTH = 32


def generate_api_key() -> str:
    """Generate a new secure API key.

    Format: nk_<32 random base64url-safe characters>
    Example: nk_aB3x9KlmN_pQrStUvWxYz123
    """
    random_part = "".join(secrets.choice(_API_KEY_ALPHABET) for _ in range(_API_KEY_LENGTH))
    return f"{_API_KEY_PREFIX}{random_part}"


def hash_api_key(key: str) -> str:
    """Hash an API key using the same bcrypt context as passwords."""
    return pwd_context.hash(key)


def verify_api_key(key: str, hashed: str) -> bool:
    """Verify an API key against its hash."""
    try:
        return pwd_context.verify(key, hashed)
    except (ValueError, TypeError):
        return False


async def create_api_key(
    user_id: int, name: str, scopes: list[str] | None = None, expires_at: datetime | None = None
) -> dict:
    """Create a new API key for a user.

    Returns the plaintext key ONLY once. The caller must show it to the user
    immediately — it cannot be retrieved later.
    """
    key = generate_api_key()
    key_hash = hash_api_key(key)
    key_prefix = key[len(_API_KEY_PREFIX):len(_API_KEY_PREFIX) + 8]
    last_4 = key[-4:]
    scopes_json = scopes if scopes is not None else ["read", "write"]

    repo = await _get_user_repo()
    record = await repo.create_api_key(
        user_id=user_id,
        name=name,
        key_hash=key_hash,
        scopes=scopes_json,
        key_prefix=key_prefix,
        last_4=last_4,
        expires_at=expires_at,
    )
    record["key"] = key
    return record


async def list_api_keys(user_id: int) -> list[dict]:
    """List all non-revoked API keys for a user."""
    repo = await _get_user_repo()
    return await repo.list_api_keys(user_id)


async def revoke_all_user_api_keys(user_id: int) -> None:
    """Revoke all API keys for a user (e.g., password change)."""
    repo = await _get_user_repo()
    await repo.revoke_all_api_keys(user_id)


async def revoke_api_key(user_id: int, key_id: str) -> bool:
    """Revoke an API key. Returns True if the key existed and belonged to the user."""
    repo = await _get_user_repo()
    return await repo.revoke_api_key(user_id, key_id)


async def authenticate_api_key(key: str) -> dict | None:
    """Authenticate a request by API key.

    Looks up the key hash in the database, verifies it with bcrypt,
    updates last_used_at, and returns the associated user dict.
    Rejects expired keys.
    Includes the key's scopes in the returned dict under '_api_key_scopes'.

    Candidate rows are filtered by ``last_4`` before bcrypt verification to
    avoid a full table scan + CPU-heavy comparison against every active key.
    """
    if not key.startswith(_API_KEY_PREFIX) or len(key) < len(_API_KEY_PREFIX) + 8:
        return None

    key_prefix = key[len(_API_KEY_PREFIX):len(_API_KEY_PREFIX) + 8]
    last_4 = key[-4:]

    repo = await _get_user_repo()
    rows = await repo.find_api_key_candidates(key_prefix, last_4)

    for row in rows:
        if verify_api_key(key, row["key_hash"]):
            await repo.update_api_key_last_used(row["id"])
            user = await get_user_by_id(str(row["user_id"]))
            if user:
                user["_api_key_scopes"] = row["scopes"] if row["scopes"] else ["read", "write"]
            return user

    return None


# ─── Refresh Token Management ────────────────────────────────────

_REF_TOKEN_ALPHABET = string.ascii_letters + string.digits + "-_"
_REF_TOKEN_LENGTH = 43  # ~256 bits of entropy in base64


def generate_refresh_token() -> str:
    """Generate a cryptographically secure opaque refresh token."""
    return "".join(secrets.choice(_REF_TOKEN_ALPHABET) for _ in range(_REF_TOKEN_LENGTH))


def hash_refresh_token(token: str) -> str:
    """Hash a refresh token using bcrypt."""
    return pwd_context.hash(token)


def verify_refresh_token(token: str, hashed: str) -> bool:
    """Verify a refresh token against its hash."""
    try:
        return pwd_context.verify(token, hashed)
    except (ValueError, TypeError):
        return False


async def create_refresh_token_db(user_id: int, token: str, family_id: str | None = None) -> dict:
    """Store a refresh token in the database. Returns the DB row dict."""
    repo = await _get_user_repo()
    token_hash = hash_refresh_token(token)
    expires_at = datetime.now(UTC) + timedelta(days=settings.refresh_token_expire_days)
    family = family_id or str(uuid.uuid4())
    return await repo.create_refresh_token(user_id, token_hash, expires_at, family)


async def verify_refresh_token_db(token: str) -> dict | None:
    """Verify a refresh token against the database.

    Returns the token row dict if valid, None otherwise.
    Does NOT rotate or revoke — just verifies.
    """
    repo = await _get_user_repo()
    rows = await repo.list_active_refresh_tokens()
    for row in rows:
        if verify_refresh_token(token, row["token_hash"]):
            return row
    return None


async def is_refresh_token_reused(token_id: int) -> bool:
    """Return True if the refresh token has already been rotated (reused)."""
    repo = await _get_user_repo()
    replaced = await repo.get_refresh_token_replacement(token_id)
    return replaced is not None


async def rotate_refresh_token(old_token_id: int, new_token: str) -> dict:
    """Rotate a refresh token: revoke old, create new, link them.

    Returns the new token row dict.
    """
    repo = await _get_user_repo()
    token_hash = hash_refresh_token(new_token)
    expires_at = datetime.now(UTC) + timedelta(days=settings.refresh_token_expire_days)
    return await repo.rotate_refresh_token(old_token_id, token_hash, expires_at)


async def revoke_refresh_token_family(family_id: str) -> None:
    """Revoke all refresh tokens in a family (reuse detection)."""
    repo = await _get_user_repo()
    await repo.revoke_refresh_token_family(family_id)


async def revoke_all_user_refresh_tokens(user_id: int) -> None:
    """Revoke all refresh tokens for a user (e.g., password change)."""
    repo = await _get_user_repo()
    await repo.revoke_all_user_refresh_tokens(user_id)
