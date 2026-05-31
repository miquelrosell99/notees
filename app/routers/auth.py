"""Authentication router.

Handles user registration, login, token management, and API keys.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from slowapi import Limiter
from slowapi.util import get_remote_address

from .. import auth
from ..logging_config import get_logger
from ..models import (
    ApiKeyCreate,
    ApiKeyCreateResponse,
    ApiKeyResponse,
    Token,
    User,
    UserCreate,
    UserLogin,
    UserUpdate,
)

logger = get_logger(__name__)

router = APIRouter(prefix="/api/auth", tags=["Authentication"])
security = HTTPBearer(auto_error=False)
limiter = Limiter(key_func=get_remote_address)


async def _resolve_user_from_auth(
    credentials: HTTPAuthorizationCredentials | None,
    api_key: str | None,
) -> dict | None:
    """Resolve user from either JWT bearer token or X-API-Key header."""
    # Prefer API key if present
    if api_key:
        user = await auth.authenticate_api_key(api_key)
        if user:
            return user
        return None

    # Fall back to JWT
    if credentials:
        payload = auth.decode_token(credentials.credentials)
        if payload:
            user_id = payload.get("user_id")
            if user_id:
                user = await auth.get_user_by_id(user_id)
                if user:
                    return user
    return None


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),  # noqa: B008
) -> User:
    """Get the current authenticated user from JWT token or X-API-Key header."""
    api_key = request.headers.get("X-API-Key")
    user_dict = await _resolve_user_from_auth(credentials, api_key)

    if not user_dict:
        raise HTTPException(status_code=401, detail="Not authenticated")

    return User(**user_dict)


async def get_current_user_optional(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),  # noqa: B008
) -> User | None:
    """Get the current authenticated user, or None if not authenticated."""
    api_key = request.headers.get("X-API-Key")
    user_dict = await _resolve_user_from_auth(credentials, api_key)

    if not user_dict:
        return None

    return User(**user_dict)


async def require_admin(user: User = Depends(get_current_user)) -> User:  # noqa: B008
    """Require admin role."""
    if user.role != "admin":
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
    role = "admin" if is_first else "user"

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


# ─── API Key Management ──────────────────────────────────────────


@router.post("/api-keys", response_model=ApiKeyCreateResponse)
async def create_api_key_endpoint(
    data: ApiKeyCreate,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Create a new API key for device access.

    The plaintext key is returned **once** — copy it immediately.
    It cannot be retrieved later.
    """
    try:
        result = await auth.create_api_key(int(user.id), data.name)
        return ApiKeyCreateResponse(**result)
    except Exception as e:
        logger.error(f"Failed to create API key for user {user.id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to create API key") from e


@router.get("/api-keys", response_model=list[ApiKeyResponse])
async def list_api_keys_endpoint(
    user: User = Depends(get_current_user),  # noqa: B008
):
    """List all active API keys for the current user."""
    keys = await auth.list_api_keys(int(user.id))
    return [ApiKeyResponse(**k) for k in keys]


@router.delete("/api-keys/{key_id}")
async def revoke_api_key_endpoint(
    key_id: str,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Revoke an API key."""
    success = await auth.revoke_api_key(int(user.id), key_id)
    if not success:
        raise HTTPException(status_code=404, detail="API key not found or already revoked")
    return {"success": True}
