"""Authentication module for Notees.

Handles user authentication, JWT tokens, and password hashing.
Uses PostgreSQL for user storage.
Default admin credentials: admin/admin
"""
from datetime import datetime, timedelta, timezone
from typing import Optional
from pathlib import Path

from jose import JWTError, jwt
from passlib.context import CryptContext

from .config import settings
from .logging_config import get_logger
from .db.connection import get_connection

logger = get_logger(__name__)

# Password hashing context
# Use pbkdf2_sha256 to avoid any bcrypt backend interaction and length limits
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


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


def create_token(user_id: str, username: str) -> str:
    """Create a JWT token."""
    expires_delta = timedelta(hours=settings.access_token_expire_hours)
    expire = datetime.now(timezone.utc) + expires_delta
    
    payload = {
        "user_id": user_id,
        "username": username,
        "exp": expire
    }
    
    token = jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)
    return token


def decode_token(token: str) -> Optional[dict]:
    """Decode and verify a JWT token."""
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        return payload
    except JWTError as e:
        logger.warning(f"Token decode error: {e}")
        return None


async def get_user_by_id(user_id: str) -> Optional[dict]:
    """Get a user by ID (numeric or UUID string)."""
    async with get_connection() as conn:
        row = await conn.fetchrow(
            '''
            SELECT id, uuid, username, password_hash as hashed_password, 
                   active, create_date as created_at
            FROM "user" 
            WHERE id::text = $1 OR uuid::text = $1
            ''',
            user_id
        )
        if row:
            return {
                "id": str(row['id']),
                "uuid": str(row['uuid']),
                "username": row['username'],
                "hashed_password": row['hashed_password'],
                "is_active": row['active'],
                "created_at": row['created_at'].isoformat() if row['created_at'] else None,
            }
    return None


async def get_user_by_username(username: str) -> Optional[dict]:
    """Get a user by username."""
    async with get_connection() as conn:
        row = await conn.fetchrow(
            '''
            SELECT id, uuid, username, password_hash as hashed_password, 
                   active, create_date as created_at
            FROM "user" 
            WHERE username = $1
            ''',
            username
        )
        if row:
            return {
                "id": str(row['id']),
                "uuid": str(row['uuid']),
                "username": row['username'],
                "hashed_password": row['hashed_password'],
                "is_active": row['active'],
                "created_at": row['created_at'].isoformat() if row['created_at'] else None,
            }
    return None


async def create_user(username: str, password: str) -> dict:
    """Create a new user."""
    # Check if username exists
    existing = await get_user_by_username(username)
    if existing:
        logger.warning(f"Attempted to create duplicate user: {username}")
        raise ValueError(f"Username '{username}' already exists")
    
    hashed = hash_password(password)
    
    async with get_connection() as conn:
        row = await conn.fetchrow(
            '''
            INSERT INTO "user" (username, password_hash, active)
            VALUES ($1, $2, TRUE)
            RETURNING id, uuid, username, active, create_date as created_at
            ''',
            username, hashed
        )
        if row is None:
            raise RuntimeError("Failed to create user")
        
        user = {
            "id": str(row['id']),
            "uuid": str(row['uuid']),
            "username": row['username'],
            "hashed_password": hashed,
            "is_active": row['active'],
            "created_at": row['created_at'].isoformat() if row['created_at'] else None,
        }
        
        logger.info(f"Created new user: {username} (ID: {user['id']})")
        return user


async def authenticate_user(username: str, password: str) -> Optional[dict]:
    """Authenticate a user and return user data if valid."""
    user = await get_user_by_username(username)
    if not user:
        logger.warning(f"Authentication failed for '{username}': user not found")
        return None

    verified = verify_password(password, user.get("hashed_password", ""))
    logger.debug(f"Authentication attempt for user '{username}': verified={bool(verified)}")
    if not verified:
        logger.warning(f"Authentication failed for '{username}': invalid password")
        return None

    if not user.get("is_active", True):
        logger.warning(f"Authentication failed for '{username}': account inactive")
        return None

    logger.info(f"Authentication successful for user '{username}' (id={user.get('id')})")
    return user


async def ensure_admin_user():
    """Ensure an admin user exists with secure credentials."""
    import os
    import secrets
    
    existing = await get_user_by_username("admin")
    if existing:
        return
    
    # Check for admin password in environment
    admin_password = os.environ.get("ADMIN_PASSWORD")
    
    if admin_password:
        await create_user("admin", admin_password)
        logger.info("Created admin user with password from ADMIN_PASSWORD env var")
    else:
        # Generate secure random password
        generated_password = secrets.token_urlsafe(16)
        await create_user("admin", generated_password)
        logger.warning("=" * 60)
        logger.warning("ADMIN USER CREATED WITH GENERATED PASSWORD")
        logger.warning(f"Username: admin")
        logger.warning(f"Password: {generated_password}")
        logger.warning("SAVE THIS PASSWORD - IT WILL NOT BE SHOWN AGAIN")
        logger.warning("Set ADMIN_PASSWORD env var to use a specific password")
        logger.warning("=" * 60)


async def get_current_user_from_token(token: str) -> Optional[dict]:
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
