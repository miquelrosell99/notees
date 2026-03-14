"""Authentication router.

Handles user registration, login, and token management.
"""
from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from slowapi import Limiter
from slowapi.util import get_remote_address

from ..models import UserCreate, UserLogin, Token, User
from .. import auth
from ..logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/auth", tags=["Authentication"])
security = HTTPBearer(auto_error=False)
limiter = Limiter(key_func=get_remote_address)


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
@limiter.limit("3/minute")  # 3 registrations per minute per IP
async def register(request: Request, user_data: UserCreate):
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
@limiter.limit("5/minute")  # 5 attempts per minute per IP
async def login(request: Request, credentials: UserLogin):
    """Login and get access token."""
    logger.info(f"Login attempt for user: '{credentials.username}'")

    # Detailed checks so we can log specific failure reasons
    user = await auth.get_user_by_username(credentials.username)
    if not user:
        logger.warning(f"Login failed for '{credentials.username}': user not found")
        raise HTTPException(status_code=401, detail="Invalid username or password")

    stored_hash = user.get("hashed_password", "")
    if not auth.verify_password(credentials.password, stored_hash):
        logger.warning(f"Login failed for '{credentials.username}': invalid password")
        raise HTTPException(status_code=401, detail="Invalid username or password")

    if not user.get("is_active", True):
        logger.warning(f"Login failed for '{credentials.username}': account inactive")
        raise HTTPException(status_code=401, detail="Invalid username or password")

    logger.info(f"Login successful for '{credentials.username}' (id={user.get('id')})")
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
