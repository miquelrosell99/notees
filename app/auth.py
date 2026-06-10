"""Authentication module for Notees.

Handles user authentication, JWT tokens, and password hashing.
Uses PostgreSQL for user storage.
"""

import secrets
import string
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
from jwt import PyJWTError
from passlib.context import CryptContext

from .config import settings
from .db.connection import get_connection
from .logging_config import get_logger

logger = get_logger(__name__)

# In-memory user cache to avoid DB pool acquisition on every request
# Maps user_id (str) -> (user_dict, cached_at_timestamp)
_user_cache: dict[str, tuple[dict, float]] = {}
_USER_CACHE_TTL = 300  # 5 minutes

# Password hashing context
# Primary: bcrypt (recommended by security-hardening skill).
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    """Hash a password."""
    return pwd_context.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    """Verify a password against its hash."""
    try:
        return pwd_context.verify(password, hashed)
    except Exception as e:
        logger.error(f"Password verification failed for technical reasons: {e}")
        return False




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

    async with get_connection() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, uuid, email, password_hash as hashed_password, name, surnames,
                   profile_pic, role, active, create_date as created_at
            FROM "user"
            WHERE id::text = $1 OR uuid::text = $1
            """,
            user_id,
        )
        if row:
            result = {
                "id": str(row["id"]),
                "uuid": str(row["uuid"]),
                "email": row["email"],
                "name": row["name"],
                "surnames": row["surnames"],
                "profile_pic": row["profile_pic"],
                "role": row["role"],
                "hashed_password": row["hashed_password"],
                "is_active": row["active"],
                "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            }
            _user_cache[user_id] = (result, now)
            return result
    return None


async def get_user_by_email(email: str) -> dict | None:
    """Get a user by email."""
    async with get_connection() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, uuid, email, password_hash as hashed_password, name, surnames,
                   profile_pic, role, active, create_date as created_at
            FROM "user"
            WHERE email = $1
            """,
            email,
        )
        if row:
            return {
                "id": str(row["id"]),
                "uuid": str(row["uuid"]),
                "email": row["email"],
                "name": row["name"],
                "surnames": row["surnames"],
                "profile_pic": row["profile_pic"],
                "role": row["role"],
                "hashed_password": row["hashed_password"],
                "is_active": row["active"],
                "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            }
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
    existing = await get_user_by_email(email)
    if existing:
        logger.warning(f"Attempted to create duplicate user: {email}")
        raise ValueError(f"Email '{email}' already exists")

    hashed = hash_password(password)

    async with get_connection() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO "user" (email, password_hash, name, surnames, profile_pic, role, active)
            VALUES ($1, $2, $3, $4, $5, $6, TRUE)
            RETURNING id, uuid, email, name, surnames, profile_pic, role, active, create_date as created_at
            """,
            email,
            hashed,
            name,
            surnames,
            profile_pic,
            role,
        )
        if row is None:
            raise RuntimeError("Failed to create user")

        user = {
            "id": str(row["id"]),
            "uuid": str(row["uuid"]),
            "email": row["email"],
            "name": row["name"],
            "surnames": row["surnames"],
            "profile_pic": row["profile_pic"],
            "role": row["role"],
            "hashed_password": hashed,
            "is_active": row["active"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        }

        logger.info(f"Created new user: {email} (ID: {user['id']}, role: {role})")
        return user


async def update_user(user_id: str, **fields) -> dict | None:
    """Update a user's profile fields."""
    allowed = {"name", "surnames", "profile_pic"}
    updates = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if not updates:
        return await get_user_by_id(user_id)

    set_clauses = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(updates))
    values = list(updates.values())

    async with get_connection() as conn:
        row = await conn.fetchrow(
            f"""
            UPDATE "user" SET {set_clauses}, write_date = NOW()
            WHERE id::text = $1 OR uuid::text = $1
            RETURNING id, uuid, email, name, surnames, profile_pic, role, active, create_date as created_at
            """,
            user_id,
            *values,
        )
        if row:
            # Invalidate cache
            _user_cache.pop(user_id, None)
            return {
                "id": str(row["id"]),
                "uuid": str(row["uuid"]),
                "email": row["email"],
                "name": row["name"],
                "surnames": row["surnames"],
                "profile_pic": row["profile_pic"],
                "role": row["role"],
                "is_active": row["active"],
                "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            }
    return None


async def authenticate_user(email: str, password: str) -> dict | None:
    """Authenticate a user and return user data if valid."""
    user = await get_user_by_email(email)
    if not user:
        logger.warning(f"Authentication failed for '{email}': user not found")
        return None

    verified = verify_password(password, user.get("hashed_password", ""))
    logger.debug(f"Authentication attempt for user '{email}': verified={bool(verified)}")
    if not verified:
        logger.warning(f"Authentication failed for '{email}': invalid password")
        return None

    if not user.get("is_active", True):
        logger.warning(f"Authentication failed for '{email}': account inactive")
        return None


    logger.info(f"Authentication successful for user '{email}' (id={user.get('id')})")
    return user


async def is_first_boot() -> bool:
    """Check if the system has no users yet (first boot)."""
    async with get_connection() as conn:
        count = await conn.fetchval('SELECT COUNT(*) FROM "user"')
        return count == 0


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
    except Exception:
        return False


async def create_api_key(user_id: int, name: str, scopes: list[str] | None = None, expires_at: datetime | None = None) -> dict:
    """Create a new API key for a user.

    Returns the plaintext key ONLY once. The caller must show it to the user
    immediately — it cannot be retrieved later.
    """
    key = generate_api_key()
    key_hash = hash_api_key(key)
    last_4 = key[-4:]
    scopes_json = scopes if scopes is not None else ["read", "write"]

    async with get_connection() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO api_key (user_id, name, key_hash, scopes, last_4, expires_at)
            VALUES ($1, $2, $3, $4::jsonb, $5, $6)
            RETURNING id, uuid, name, scopes, last_4, revoked, create_date, expires_at
            """,
            user_id,
            name,
            key_hash,
            scopes_json,
            last_4,
            expires_at,
        )
        if row is None:
            raise RuntimeError("Failed to create API key")

        return {
            "id": str(row["id"]),
            "uuid": str(row["uuid"]),
            "name": row["name"],
            "key": key,
            "scopes": row["scopes"],
            "last_4": row["last_4"],
            "revoked": row["revoked"],
            "created_at": row["create_date"].isoformat() if row["create_date"] else None,
            "expires_at": row["expires_at"].isoformat() if row["expires_at"] else None,
        }


async def list_api_keys(user_id: int) -> list[dict]:
    """List all non-revoked API keys for a user."""
    async with get_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT id, uuid, name, scopes, last_4, last_used_at, revoked, create_date, expires_at
            FROM api_key
            WHERE user_id = $1 AND revoked = FALSE
            ORDER BY create_date DESC
            """,
            user_id,
        )
        return [
            {
                "id": str(row["id"]),
                "uuid": str(row["uuid"]),
                "name": row["name"],
                "scopes": row["scopes"],
                "last_4": row["last_4"],
                "last_used_at": row["last_used_at"].isoformat() if row["last_used_at"] else None,
                "revoked": row["revoked"],
                "created_at": row["create_date"].isoformat() if row["create_date"] else None,
                "expires_at": row["expires_at"].isoformat() if row["expires_at"] else None,
            }
            for row in rows
        ]


async def revoke_api_key(user_id: int, key_id: str) -> bool:
    """Revoke an API key. Returns True if the key existed and belonged to the user."""
    async with get_connection() as conn:
        result = await conn.execute(
            """
            UPDATE api_key SET revoked = TRUE, write_date = NOW()
            WHERE id::text = $1 AND user_id = $2 AND revoked = FALSE
            """,
            key_id,
            user_id,
        )
        # asyncpg execute returns a status string like "UPDATE 1"
        return result.startswith("UPDATE 1")


async def authenticate_api_key(key: str) -> dict | None:
    """Authenticate a request by API key.

    Looks up the key hash in the database, verifies it with bcrypt,
    updates last_used_at, and returns the associated user dict.
    Rejects expired keys.
    Includes the key's scopes in the returned dict under '_api_key_scopes'.
    """
    if not key.startswith(_API_KEY_PREFIX):
        return None

    async with get_connection() as conn:
        # Fetch all non-revoked, non-expired keys.
        rows = await conn.fetch(
            """
            SELECT id, user_id, key_hash, expires_at, scopes
            FROM api_key
            WHERE revoked = FALSE
              AND (expires_at IS NULL OR expires_at > NOW())
            """
        )

        for row in rows:
            if verify_api_key(key, row["key_hash"]):
                # Update last_used_at
                await conn.execute(
                    "UPDATE api_key SET last_used_at = NOW() WHERE id = $1",
                    row["id"],
                )
                user = await get_user_by_id(str(row["user_id"]))
                if user:
                    user["_api_key_scopes"] = row["scopes"] if row["scopes"] else ["read", "write"]
                return user

    return None
