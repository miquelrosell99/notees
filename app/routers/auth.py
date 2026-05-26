"""Authentication router.

Handles user registration, login, and token management.
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from slowapi import Limiter
from slowapi.util import get_remote_address

from .. import auth
from ..logging_config import get_logger
from ..models import Token, User, UserCreate, UserLogin, UserUpdate

logger = get_logger(__name__)

router = APIRouter(prefix="/api/auth", tags=["Authentication"])
security = HTTPBearer(auto_error=False)
limiter = Limiter(key_func=get_remote_address)


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> User:  # noqa: B008
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


async def get_current_user_optional(credentials: HTTPAuthorizationCredentials = Depends(security)) -> User | None:  # noqa: B008
    """Get the current authenticated user, or None if not authenticated."""
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


async def require_admin(user: User = Depends(get_current_user)) -> User:  # noqa: B008
    """Require admin role."""
    if user.role != 'admin':
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


@router.get("/status")
async def auth_status():
    """Get authentication system status (for onboarding gate)."""
    needs_onboarding = await auth.is_first_boot()
    return {
        "needs_onboarding": needs_onboarding,
        "authenticated": False,
    }


@router.post("/register", response_model=Token)
@limiter.limit("3/minute")
async def register(request: Request, user_data: UserCreate):
    """Register a new user."""
    existing = await auth.get_user_by_email(user_data.email)
    if existing:
        raise HTTPException(status_code=400, detail="Email already exists")

    # If this is the first user, make them admin
    is_first = await auth.is_first_boot()
    role = 'admin' if is_first else 'user'

    user = await auth.create_user(
        email=user_data.email,
        password=user_data.password,
        name=user_data.name,
        surnames=user_data.surnames,
        profile_pic=user_data.profile_pic,
        role=role,
    )

    token = auth.create_token(user["id"], user["email"], user["role"])
    return {"access_token": token, "token_type": "bearer", "user": user}


@router.post("/login", response_model=Token)
@limiter.limit("5/minute")
async def login(request: Request, credentials: UserLogin):
    """Login and get access token."""
    logger.info(f"Login attempt for user: '{credentials.email}'")

    user = await auth.get_user_by_email(credentials.email)
    if not user:
        logger.warning(f"Login failed for '{credentials.email}': user not found")
        raise HTTPException(status_code=401, detail="Invalid email or password")

    stored_hash = user.get("hashed_password", "")
    if not auth.verify_password(credentials.password, stored_hash):
        logger.warning(f"Login failed for '{credentials.email}': invalid password")
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not user.get("is_active", True):
        logger.warning(f"Login failed for '{credentials.email}': account inactive")
        raise HTTPException(status_code=401, detail="Invalid email or password")

    logger.info(f"Login successful for '{credentials.email}' (id={user.get('id')})")
    token = auth.create_token(user["id"], user["email"], user["role"])
    return {"access_token": token, "token_type": "bearer", "user": user}


@router.get("/me")
async def get_me(user: User = Depends(get_current_user)):  # noqa: B008
    """Get current user info."""
    return {
        "id": user.id,
        "uuid": user.uuid,
        "email": user.email,
        "name": user.name,
        "surnames": user.surnames,
        "profile_pic": user.profile_pic,
        "role": user.role,
        "created_at": user.created_at,
    }


@router.put("/me")
async def update_me(
    data: UserUpdate,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Update current user profile."""
    updated = await auth.update_user(
        user.id,
        name=data.name,
        surnames=data.surnames,
        profile_pic=data.profile_pic,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")
    return updated
