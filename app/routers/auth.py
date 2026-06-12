"""Authentication router.

Handles user registration, login, token management, and API keys.
"""

import time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi_limiter.depends import RateLimiter
from pyrate_limiter import Duration

from .. import auth
from ..config import settings
from ..logging_config import get_logger
from ..models import (
    ApiKeyCreate,
    ApiKeyCreateResponse,
    ApiKeyResponse,
    InviteAcceptRequest,
    Token,
    User,
    UserCreate,
    UserLogin,
    UserUpdate,
)
from ..rate_limit import ip_only_identifier, per_ip_limiter

logger = get_logger(__name__)

router = APIRouter(prefix="/auth", tags=["Authentication"])
security = HTTPBearer(auto_error=False)

_auth_limiter_register = per_ip_limiter(3, Duration.MINUTE)
_auth_limiter_login = per_ip_limiter(5, Duration.MINUTE)
_auth_limiter_refresh = per_ip_limiter(10, Duration.MINUTE)
_auth_limiter_invite = per_ip_limiter(5, Duration.MINUTE)
_auth_limiter_api_key = per_ip_limiter(10, Duration.MINUTE)


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


# In-memory cache for API key scopes to avoid re-authenticating on every scope check
_api_key_scope_cache: dict[str, tuple[list[str], float]] = {}
_API_KEY_SCOPE_TTL = 60  # 1 minute


async def _get_api_key_scopes(api_key: str) -> list[str] | None:
    """Return scopes for a valid API key (cached)."""
    now = time.monotonic()
    cached = _api_key_scope_cache.get(api_key)
    if cached is not None:
        scopes, cached_at = cached
        if now - cached_at < _API_KEY_SCOPE_TTL:
            return scopes

    user = await auth.authenticate_api_key(api_key)
    if not user:
        return None

    scopes = user.get("_api_key_scopes", ["read", "write"])
    _api_key_scope_cache[api_key] = (scopes, now)
    return scopes


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


class RequireScope:
    """Dependency factory that enforces API key scopes.

    JWT tokens are always granted full access.
    API keys must have at least one of the required scopes.
    """

    def __init__(self, *scopes: str):
        self.scopes = set(scopes)

    async def __call__(
        self,
        request: Request,
        user: User = Depends(get_current_user),  # noqa: B008
    ) -> User:
        api_key = request.headers.get("X-API-Key")
        if api_key:
            key_scopes = await _get_api_key_scopes(api_key)
            if key_scopes is None:
                raise HTTPException(status_code=401, detail="Invalid or expired API key")
            if not self.scopes.intersection(set(key_scopes)):
                raise HTTPException(
                    status_code=403,
                    detail=f"API key lacks required scope. Required one of: {', '.join(self.scopes)}",
                )
        return user


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
        "registration_enabled": settings.registration_enabled,
    }


def _set_refresh_cookie(response: Response, token: str) -> None:
    """Set the refresh token HTTPOnly cookie."""
    max_age = settings.refresh_token_expire_days * 24 * 60 * 60
    # In production, require HTTPS for the refresh token cookie regardless of
    # PUBLIC_URL configuration, and use Strict SameSite to prevent CSRF.
    is_production = settings.environment.lower() == "production"
    response.set_cookie(
        key="refresh_token",
        value=token,
        httponly=True,
        secure=is_production or settings.public_url.startswith("https://"),
        samesite="strict",
        max_age=max_age,
        path="/api/auth/refresh",
    )


@router.post(
    "/register",
    response_model=Token,
    dependencies=[Depends(RateLimiter(limiter=_auth_limiter_register))],
)
async def register(request: Request, response: Response, user_data: UserCreate):
    """Register a new user."""
    is_first = await auth.is_first_boot()
    if not settings.registration_enabled and not is_first:
        raise HTTPException(status_code=403, detail="Registration is disabled")

    existing = await auth.get_user_by_email(user_data.email)
    if existing:
        raise HTTPException(status_code=400, detail="Email already exists")

    # If this is the first user, make them admin
    role = "admin" if is_first else "user"

    user = await auth.create_user(
        email=user_data.email,
        password=user_data.password,
        name=user_data.name,
        surnames=user_data.surnames,
        profile_pic=user_data.profile_pic,
        role=role,
    )

    access_token = auth.create_token(user["id"], user["email"], user["role"])
    refresh_token = auth.generate_refresh_token()
    await auth.create_refresh_token_db(int(user["id"]), refresh_token)
    _set_refresh_cookie(response, refresh_token)

    return {"access_token": access_token, "refresh_token": refresh_token, "token_type": "bearer", "user": user}


@router.post(
    "/login",
    response_model=Token,
    dependencies=[Depends(RateLimiter(limiter=_auth_limiter_login))],
)
async def login(request: Request, response: Response, credentials: UserLogin):
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
    access_token = auth.create_token(user["id"], user["email"], user["role"])
    refresh_token = auth.generate_refresh_token()
    await auth.create_refresh_token_db(int(user["id"]), refresh_token)
    _set_refresh_cookie(response, refresh_token)

    return {"access_token": access_token, "refresh_token": refresh_token, "token_type": "bearer", "user": user}


@router.post(
    "/refresh",
    dependencies=[Depends(RateLimiter(limiter=_auth_limiter_refresh, identifier=ip_only_identifier))],
)
async def refresh_access_token(request: Request, response: Response):
    """Refresh access token using refresh token cookie.

    Returns a new access token and rotates the refresh token.
    On reuse detection, revokes the entire token family.
    """
    refresh_token = request.cookies.get("refresh_token")
    if not refresh_token:
        raise HTTPException(status_code=401, detail="No refresh token provided")

    token_row = await auth.verify_refresh_token_db(refresh_token)
    if not token_row:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    # Check if token was already used (rotated). Reuse detection is delegated to
    # the auth module so the router does not execute SQL directly.
    if await auth.is_refresh_token_reused(token_row["id"]):
        await auth.revoke_refresh_token_family(token_row["family_id"])
        raise HTTPException(status_code=401, detail="Refresh token reuse detected")

    # Rotate refresh token
    new_refresh_token = auth.generate_refresh_token()
    await auth.rotate_refresh_token(token_row["id"], new_refresh_token)

    # Get user and create new access token
    user = await auth.get_user_by_id(str(token_row["user_id"]))
    if not user or not user.get("is_active", True):
        raise HTTPException(status_code=401, detail="User not found or inactive")

    access_token = auth.create_token(
        user_id=str(user["id"]),
        email=user["email"],
        role=user["role"],
    )

    # Set new refresh token cookie
    _set_refresh_cookie(response, new_refresh_token)

    return {
        "access_token": access_token,
        "token_type": "bearer",
    }


@router.post(
    "/invites/accept",
    dependencies=[Depends(RateLimiter(limiter=_auth_limiter_invite, identifier=ip_only_identifier))],
)
async def accept_invite(request: Request, response: Response, body: InviteAcceptRequest):
    """Accept a pending invitation and create/login user.

    If the user already exists, this converts the pending invite to a share.
    If not, a new user is created (if registration is enabled or this is first boot).
    """
    from ..db.connection import get_connection

    async with get_connection() as conn:
        invite = await conn.fetchrow(
            """
            SELECT id, email, workspace_id, node_id, role, invited_by, expires_at
            FROM pending_invite
            WHERE uuid::text = $1 AND active = TRUE
            """,
            body.token,
        )
        if not invite:
            raise HTTPException(status_code=404, detail="Invite not found or expired")

        if invite["expires_at"] and invite["expires_at"] < datetime.now():
            await conn.execute(
                "UPDATE pending_invite SET active = FALSE WHERE id = $1", invite["id"]
            )
            raise HTTPException(status_code=410, detail="Invite has expired")

        email = invite["email"]
        existing = await auth.get_user_by_email(email)

        if existing:
            user_id = int(existing["id"])
        else:
            is_first = await auth.is_first_boot()
            if not settings.registration_enabled and not is_first:
                raise HTTPException(status_code=403, detail="Registration is disabled")

            if not body.password:
                raise HTTPException(status_code=400, detail="Password is required to create account")

            role = "admin" if is_first else "user"
            user = await auth.create_user(
                email=email,
                password=body.password,
                name=body.name,
                role=role,
            )
            user_id = int(user["id"])

        # Convert pending invite to actual share
        if invite["workspace_id"]:
            perms = {"viewer": (True, False, False, False, False), "commenter": (True, False, False, False, True), "editor": (True, True, True, False, True), "admin": (True, True, True, True, True)}.get(
                invite["role"], (True, False, False, False, False)
            )
            await conn.execute(
                """
                INSERT INTO workspace_share (workspace_id, user_id, can_read, can_write, can_create, can_delete, can_comment, active, create_uid, write_uid)
                VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $8)
                ON CONFLICT (workspace_id, user_id)
                DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write,
                              can_create = EXCLUDED.can_create, can_delete = EXCLUDED.can_delete,
                              can_comment = EXCLUDED.can_comment, active = TRUE, write_uid = EXCLUDED.write_uid,
                              write_date = NOW()
                """,
                invite["workspace_id"],
                user_id,
                perms[0],
                perms[1],
                perms[2],
                perms[3],
                perms[4],
                invite["invited_by"],
            )
            await conn.execute(
                "UPDATE workspace SET is_shared = TRUE WHERE id = $1",
                invite["workspace_id"],
            )

        if invite["node_id"]:
            perm = invite["role"]  # "read" or "write"
            can_write = perm == "write"
            await conn.execute(
                """
                INSERT INTO node_share (node_id, user_id, can_read, can_write, can_create, can_delete, can_comment, active, create_uid, write_uid)
                VALUES ($1, $2, TRUE, $3, FALSE, FALSE, FALSE, TRUE, $4, $4)
                ON CONFLICT (node_id, user_id)
                DO UPDATE SET can_read = TRUE, can_write = EXCLUDED.can_write, active = TRUE,
                              write_uid = EXCLUDED.write_uid, write_date = NOW()
                """,
                invite["node_id"],
                user_id,
                can_write,
                invite["invited_by"],
            )
            await conn.execute(
                "UPDATE node SET is_shared = TRUE WHERE id = $1",
                invite["node_id"],
            )

        await conn.execute(
            "UPDATE pending_invite SET active = FALSE WHERE id = $1",
            invite["id"],
        )

        # Get full user record for token
        user_record = await auth.get_user_by_id(user_id)
        if not user_record:
            raise HTTPException(status_code=500, detail="Failed to retrieve user after invite acceptance")

        access_token = auth.create_token(user_record["id"], user_record["email"], user_record["role"])
        refresh_token = auth.generate_refresh_token()
        await auth.create_refresh_token_db(int(user_record["id"]), refresh_token)
        _set_refresh_cookie(response, refresh_token)

        return {"access_token": access_token, "refresh_token": refresh_token, "token_type": "bearer", "user": user_record}


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


class ApiKeyCreateWithOptions(ApiKeyCreate):
    """API key creation request with optional scopes and expiration."""

    scopes: list[str] = ["read", "write"]
    expires_at: datetime | None = None


@router.post(
    "/api-keys",
    response_model=ApiKeyCreateResponse,
    dependencies=[Depends(RateLimiter(limiter=_auth_limiter_api_key, identifier=ip_only_identifier))],
)
async def create_api_key_endpoint(
    data: ApiKeyCreateWithOptions,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Create a new API key for device access.

    The plaintext key is returned **once** — copy it immediately.
    It cannot be retrieved later.
    """
    try:
        result = await auth.create_api_key(
            int(user.id), data.name, scopes=data.scopes, expires_at=data.expires_at
        )
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
