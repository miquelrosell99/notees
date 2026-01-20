"""Authentication router.

Handles user registration, login, and token management.
"""
from fastapi import APIRouter, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from ..models import UserCreate, UserLogin, Token, User
from .. import auth
from .. import database as db
from ..logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/auth", tags=["Authentication"])
security = HTTPBearer(auto_error=False)


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> User:
    """Get the current authenticated user from JWT token."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    token = credentials.credentials
    payload = auth.decode_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    
    user_id = payload.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")
    
    user = await auth.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    
    return User(**user)


async def get_current_user_optional(credentials: HTTPAuthorizationCredentials = Depends(security)) -> User | None:
    """Get the current authenticated user, or None if not authenticated.
    
    Use this for endpoints that can authenticate via other means (e.g., token query param).
    """
    if not credentials:
        return None
    
    token = credentials.credentials
    payload = auth.decode_token(token)
    if not payload:
        return None
    
    user_id = payload.get("user_id")
    if not user_id:
        return None
    
    user = await auth.get_user_by_id(user_id)
    if not user:
        return None
    
    return User(**user)


@router.post("/register", response_model=Token)
async def register(user_data: UserCreate):
    """Register a new user."""
    # Check if username exists
    existing = await auth.get_user_by_username(user_data.username)
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")
    
    # Create user
    user = await auth.create_user(user_data.username, user_data.password)
    
    # Generate token
    token = auth.create_token(user["id"], user["username"])
    return {"access_token": token, "token_type": "bearer", "user": user}


@router.post("/login", response_model=Token)
async def login(credentials: UserLogin):
    """Login and get access token."""
    import logging
    import sys
    log = logging.getLogger("app.routers.auth")
    print(f"[AUTH] Login attempt for user: '{credentials.username}'", file=sys.stderr, flush=True)
    log.info(f"Login attempt for user: '{credentials.username}'")
    
    # Detailed checks so we can log specific failure reasons
    user = await auth.get_user_by_username(credentials.username)
    if not user:
        print(f"[AUTH] Login failed for '{credentials.username}': user not found", file=sys.stderr, flush=True)
        log.warning(f"Login failed for '{credentials.username}': user not found")
        raise HTTPException(status_code=401, detail="Invalid username or password")

    # Debug logging for password verification
    stored_hash = user.get("hashed_password", "")
    print(f"[AUTH DEBUG] User ID: {user.get('id')}", file=sys.stderr, flush=True)
    print(f"[AUTH DEBUG] Password length: {len(credentials.password)}", file=sys.stderr, flush=True)
    print(f"[AUTH DEBUG] Hash prefix: {stored_hash[:30]}", file=sys.stderr, flush=True)
    log.info(f"Attempting password verification for user {credentials.username} (ID: {user.get('id')})")
    
    if not auth.verify_password(credentials.password, stored_hash):
        print(f"[AUTH] Login failed for '{credentials.username}': invalid password", file=sys.stderr, flush=True)
        log.warning(f"Login failed for '{credentials.username}': invalid password")
        raise HTTPException(status_code=401, detail="Invalid username or password")

    if not user.get("is_active", True):
        print(f"[AUTH] Login failed for '{credentials.username}': account inactive", file=sys.stderr, flush=True)
        log.warning(f"Login failed for '{credentials.username}': account inactive")
        raise HTTPException(status_code=401, detail="Invalid username or password")

    # At this point authentication is successful
    print(f"[AUTH] Login successful for '{credentials.username}' (id={user.get('id')})", file=sys.stderr, flush=True)
    log.info(f"Login successful for '{credentials.username}' (id={user.get('id')})")
    
    token = auth.create_token(user["id"], user["username"])
    return {"access_token": token, "token_type": "bearer", "user": user}


@router.get("/me")
async def get_me(user: User = Depends(get_current_user)):
    """Get current user info."""
    return {
        "id": user.id,
        "username": user.username,
        "created_at": user.created_at
    }
