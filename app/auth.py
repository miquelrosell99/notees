"""Authentication module for Notees.

Handles user authentication, JWT tokens, and password hashing.
Default admin credentials: admin/admin
"""
import json
from datetime import datetime, timedelta, timezone
from typing import Optional
from pathlib import Path
import secrets

from jose import JWTError, jwt
from passlib.context import CryptContext

from .config import settings
from .logging_config import get_logger

logger = get_logger(__name__)

# Password hashing context
# Use pbkdf2_sha256 to avoid any bcrypt backend interaction and length limits
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

USERS_DIR = settings.database_dir / "users"


def ensure_dirs():
    """Ensure required directories exist."""
    USERS_DIR.mkdir(parents=True, exist_ok=True)


def hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    return pwd_context.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    """Verify a password against its hash."""
    try:
        return pwd_context.verify(password, hashed)
    except Exception as e:
        import traceback
        logger.error(f"Password verification error: {e}")
        logger.error(f"Stack trace: {''.join(traceback.format_stack()[-4:-1])}")
        logger.error(f"Hash type: {hashed[:15] if hashed else 'EMPTY'}")
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


def get_user_file(user_id: str) -> Path:
    """Get the file path for a user."""
    return USERS_DIR / f"{user_id}.json"


async def get_user_by_id(user_id: str) -> Optional[dict]:
    """Get a user by ID."""
    user_file = get_user_file(user_id)
    if user_file.exists():
        with open(user_file, "r") as f:
            return json.load(f)
    return None


async def get_user_by_username(username: str) -> Optional[dict]:
    """Get a user by username."""
    ensure_dirs()
    matches = []
    for user_file in USERS_DIR.glob("*.json"):
        with open(user_file, "r", encoding="utf-8") as f:
            try:
                user = json.load(f)
            except Exception:
                continue
            if user.get("username") == username:
                matches.append(user)

    if not matches:
        return None

    # Return the most recently created matching user (deterministic)
    try:
        matches.sort(key=lambda u: u.get("created_at", ""))
    except Exception:
        pass

    return matches[-1]


async def create_user(username: str, password: str) -> dict:
    """Create a new user."""
    ensure_dirs()
    
    # Check if username exists
    existing = await get_user_by_username(username)
    if existing:
        logger.warning(f"Attempted to create duplicate user: {username}")
        raise ValueError(f"Username '{username}' already exists")
    
    user_id = secrets.token_hex(8)
    now = datetime.now(timezone.utc).isoformat()
    
    user = {
        "id": user_id,
        "username": username,
        "hashed_password": hash_password(password),
        "created_at": now,
        "is_active": True
    }
    
    user_file = get_user_file(user_id)
    with open(user_file, "w") as f:
        json.dump(user, f, indent=2)
    
    logger.info(f"Created new user: {username} (ID: {user_id})")
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
    """Ensure the default admin user exists."""
    ensure_dirs()
    
    existing = await get_user_by_username("admin")
    if not existing:
        logger.info("Creating default admin user...")
        await create_user("admin", "admin")
        logger.warning("Default admin user created (username: admin, password: admin) - CHANGE PASSWORD IN PRODUCTION!")


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
