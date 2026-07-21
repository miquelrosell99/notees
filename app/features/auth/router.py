"""Authentication router.

Handles user registration, login, token management, and API keys.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi_limiter.depends import RateLimiter
from pydantic import BaseModel
from pyrate_limiter import Duration

from app.config import settings
from app.db.connection import get_pool
from app.dependencies import get_current_user, get_push_device_repository, get_settings_repository
from app.domain.errors import PasswordRequiredError, RegistrationDisabledError
from app.domain.repositories.factories import make_user_repository
from app.domain.repositories.interfaces import SettingsRepository
from app.features.auth import auth as auth_module
from app.features.auth import totp
from app.features.auth.dependencies import get_invite_repository
from app.features.auth.port import InviteRepository
from app.features.notifications.port import PushDeviceRepository
from app.logging_config import get_logger
from app.models import (
    AccessTokenResponse,
    ApiKeyCreate,
    ApiKeyCreateResponse,
    ApiKeyResponse,
    DeviceTokenRegisterRequest,
    InviteAcceptRequest,
    PasswordChangeRequest,
    Token,
    TwoFactorCodeRequest,
    TwoFactorDisableRequest,
    TwoFactorEnableResponse,
    TwoFactorRequiredResponse,
    TwoFactorSetupResponse,
    TwoFactorVerifyRequest,
    User,
    UserCreate,
    UserLogin,
    UserUpdate,
)
from app.rate_limit import auth_identifier, auth_per_account_limiter, ip_only_identifier, per_ip_limiter
from app.utils.datetime_utils import utc_now
from app.utils.password import PasswordVerificationError, password_needs_rehash, verify_password


class AuthStatusResponse(BaseModel):
    """Authentication system status."""

    needs_onboarding: bool
    authenticated: bool
    registration_enabled: bool

logger = get_logger(__name__)

router = APIRouter(prefix="/auth", tags=["Authentication"])
security = HTTPBearer(auto_error=False)

_auth_limiter_register = per_ip_limiter(3, Duration.MINUTE)
_auth_limiter_login = per_ip_limiter(5, Duration.MINUTE)
_auth_limiter_refresh = per_ip_limiter(10, Duration.MINUTE)
_auth_limiter_invite = per_ip_limiter(5, Duration.MINUTE)
_auth_limiter_api_key = per_ip_limiter(10, Duration.MINUTE)

# Per-account auth limiters keyed by username/email in addition to IP.
_auth_limiter_register_account = auth_per_account_limiter(3, Duration.MINUTE)
_auth_limiter_login_account = auth_per_account_limiter(5, Duration.MINUTE)
_auth_limiter_change_password_account = auth_per_account_limiter(5, Duration.MINUTE)
_auth_limiter_invite_account = auth_per_account_limiter(5, Duration.MINUTE)

# Two-factor authentication endpoints (per-IP; verify is the sensitive path).
_auth_limiter_2fa = per_ip_limiter(10, Duration.MINUTE)
_auth_limiter_2fa_verify = per_ip_limiter(10, Duration.MINUTE)


async def _resolve_user_from_auth(
    credentials: HTTPAuthorizationCredentials | None,
    api_key: str | None,
) -> dict | None:
    """Resolve user from either JWT bearer token or X-API-Key header."""
    # Prefer API key if present
    if api_key:
        user = await auth_module.authenticate_api_key(api_key)
        if user:
            return user
        return None

    # Fall back to JWT
    if credentials:
        payload = auth_module.decode_token(credentials.credentials)
        # A 2FA pre-auth token is not a session.
        if payload and not auth_module.is_preauth_payload(payload):
            user_id = payload.get("user_id")
            if user_id:
                user = await auth_module.get_user_by_id(user_id)
                if user:
                    return user
    return None


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


@router.get("/status", response_model=AuthStatusResponse)
async def auth_status():
    """Get authentication system status (for onboarding gate)."""
    needs_onboarding = await auth_module.is_first_boot()
    return {
        "needs_onboarding": needs_onboarding,
        "authenticated": False,
        "registration_enabled": settings.registration_enabled,
    }


def _set_refresh_cookie(response: Response, token: str, remember_me: bool = False) -> None:
    """Set the refresh token HTTPOnly cookie."""
    lifetime_days = settings.refresh_token_remember_me_days if remember_me else settings.refresh_token_expire_days
    max_age = lifetime_days * 24 * 60 * 60
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


def _set_access_cookie(response: Response, token: str) -> None:
    """Set the short-lived access token HTTPOnly cookie."""
    max_age = int(settings.access_token_expire_hours * 60 * 60)
    is_production = settings.environment.lower() == "production"
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        secure=is_production or settings.public_url.startswith("https://"),
        samesite="strict",
        max_age=max_age,
        path="/api",
    )


def _clear_auth_cookies(response: Response) -> None:
    """Clear authentication cookies on logout."""
    response.delete_cookie(key="access_token", path="/api")
    response.delete_cookie(key="refresh_token", path="/api/auth/refresh")


async def _user_repo():
    """Return a UserRepository backed by the current pool."""
    return make_user_repository(await get_pool())


def _public_user(user: dict) -> dict:
    """Strip secrets (e.g. hashed_password) from a user dict for responses."""
    return {k: v for k, v in user.items() if k != "hashed_password"}


async def _issue_tokens(response: Response, user: dict, remember_me: bool = False) -> dict:
    """Create access+refresh tokens, persist the refresh token, set cookies.

    Returns the token response payload with a sanitized public user object.
    """
    access_token = auth_module.create_token(user["id"], user["email"], user["role"])
    refresh_token = auth_module.generate_refresh_token()
    await auth_module.create_refresh_token_db(int(user["id"]), refresh_token, remember_me=remember_me)
    _set_refresh_cookie(response, refresh_token, remember_me=remember_me)
    _set_access_cookie(response, access_token)
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": _public_user(user),
    }


async def require_full_or_setup_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),  # noqa: B008
) -> dict:
    """Resolve the user for 2FA setup/enable endpoints.

    Accepts a full session token or a ``2fa-setup`` pre-auth token (so an admin
    forced to enroll can complete setup). A ``2fa-verify`` token is rejected.
    """
    token = request.cookies.get("access_token")
    if credentials and not token:
        token = credentials.credentials
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    payload = auth_module.decode_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if payload.get("scope") == "2fa-verify":
        raise HTTPException(status_code=401, detail="Complete two-factor verification first")

    user_id = payload.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = await auth_module.get_user_by_id(user_id)
    if not user or not user.get("is_active", True):
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


@router.post(
    "/register",
    response_model=Token,
    dependencies=[
        Depends(RateLimiter(limiter=_auth_limiter_register)),
        Depends(RateLimiter(limiter=_auth_limiter_register_account, identifier=auth_identifier)),
    ],
)
async def register(request: Request, response: Response, user_data: UserCreate):
    """Register a new user."""
    is_first = await auth_module.is_first_boot()
    admin_password = settings.admin_password
    if is_first:
        if not admin_password:
            raise HTTPException(
                status_code=403,
                detail="Initial admin password is not configured. Set ADMIN_PASSWORD and restart the server, "
                "or run scripts/promote_user_to_admin.py to create an admin manually.",
            )
        if not auth_module.is_strong_admin_password(admin_password):
            raise HTTPException(
                status_code=403,
                detail="Configured ADMIN_PASSWORD does not meet the admin complexity requirements "
                "(minimum 12 characters, mixed case, digit, special character). "
                "Initial admin creation is blocked. Set a stronger ADMIN_PASSWORD and restart the server, "
                "or run scripts/promote_user_to_admin.py to create an admin manually.",
            )
        if not user_data.admin_password:
            raise HTTPException(
                status_code=403,
                detail="Initial admin password confirmation is required. Provide the configured ADMIN_PASSWORD.",
            )
        if user_data.admin_password != admin_password:
            raise HTTPException(
                status_code=403,
                detail="Initial admin password confirmation does not match ADMIN_PASSWORD.",
            )
    if not settings.registration_enabled and not is_first:
        raise HTTPException(status_code=403, detail="Registration is disabled")

    existing = await auth_module.get_user_by_email(user_data.email)
    if existing:
        raise HTTPException(status_code=400, detail="Email already exists")

    # If this is the first user, make them admin and use ADMIN_PASSWORD as the
    # initial password so the operator-configured password is authoritative.
    role = "admin" if is_first else "user"
    password = admin_password if is_first else user_data.password

    user = await auth_module.create_user(
        email=user_data.email,
        password=password,
        name=user_data.name,
        surnames=user_data.surnames,
        profile_pic=user_data.profile_pic,
        role=role,
    )

    access_token = auth_module.create_token(user["id"], user["email"], user["role"])
    refresh_token = auth_module.generate_refresh_token()
    await auth_module.create_refresh_token_db(int(user["id"]), refresh_token, remember_me=user_data.remember_me)
    _set_refresh_cookie(response, refresh_token, remember_me=user_data.remember_me)
    _set_access_cookie(response, access_token)

    return {"access_token": access_token, "refresh_token": refresh_token, "token_type": "bearer", "user": user}


@router.post(
    "/login",
    dependencies=[
        Depends(RateLimiter(limiter=_auth_limiter_login)),
        Depends(RateLimiter(limiter=_auth_limiter_login_account, identifier=auth_identifier)),
    ],
)
async def login(request: Request, response: Response, credentials: UserLogin):
    """Login and get access token."""
    logger.info("Login attempt")

    user = await auth_module.get_user_by_email(credentials.email)
    if not user:
        logger.warning("Login failed: user not found")
        raise HTTPException(status_code=401, detail="Invalid email or password")

    stored_hash = user.get("hashed_password", "")
    try:
        password_ok = verify_password(credentials.password, stored_hash)
    except PasswordVerificationError:
        # Technical fault (malformed hash, backend error): not a wrong password.
        # Surface a neutral temporary-outage response rather than a misleading
        # "invalid password" that would lock out a legitimate user.
        logger.exception(f"Password verification error during login (user_id={user.get('id')})")
        raise HTTPException(
            status_code=503,
            detail="Sign-in is temporarily unavailable. Please try again shortly.",
        ) from None

    if not password_ok:
        logger.warning(f"Login failed (user_id={user.get('id')}): invalid password")
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not user.get("is_active", True):
        logger.warning(f"Login failed (user_id={user.get('id')}): account inactive")
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Transparently migrate legacy pbkdf2_sha256 hashes to bcrypt on login.
    if password_needs_rehash(stored_hash):
        await auth_module.rehash_password(user["id"], credentials.password)

    logger.info(f"Login successful (user_id={user.get('id')})")

    # Two-factor gate: a password alone never yields a session when the user has
    # enabled 2FA. 2FA is strictly per-user opt-in; admins are not forced to enroll.
    if user.get("totp_enabled"):
        logger.info(f"2FA verification required (user_id={user.get('id')})")
        return TwoFactorRequiredResponse(
            preauth_token=auth_module.create_preauth_token(user["id"], "verify"),
            purpose="verify",
        ).model_dump()

    return await _issue_tokens(response, user, remember_me=credentials.remember_me)


@router.post(
    "/refresh",
    response_model=AccessTokenResponse,
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

    token_row = await auth_module.verify_refresh_token_db(refresh_token)
    if not token_row:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    # Check if token was already used (rotated). Reuse detection is delegated to
    # the auth module so the router does not execute SQL directly. If the reuse
    # occurs within the configured grace window, allow it once (multi-tab safety).
    if await auth_module.is_refresh_token_reused(token_row["id"]):
        if await auth_module.is_refresh_token_within_grace(token_row["id"]):
            await auth_module.consume_refresh_token_grace(token_row["id"])
        else:
            await auth_module.revoke_refresh_token_family(token_row["family_id"])
            raise HTTPException(status_code=401, detail="Refresh token reuse detected")

    remember_me = token_row.get("remember_me", False)

    # Rotate refresh token
    new_refresh_token = auth_module.generate_refresh_token()
    await auth_module.rotate_refresh_token(token_row["id"], new_refresh_token, remember_me=remember_me)

    # Get user and create new access token
    user = await auth_module.get_user_by_id(str(token_row["user_id"]))
    if not user or not user.get("is_active", True):
        raise HTTPException(status_code=401, detail="User not found or inactive")

    access_token = auth_module.create_token(
        user_id=str(user["id"]),
        email=user["email"],
        role=user["role"],
    )

    # Set new refresh token cookie
    _set_refresh_cookie(response, new_refresh_token, remember_me=remember_me)
    _set_access_cookie(response, access_token)

    return {"access_token": access_token, "token_type": "bearer"}


@router.post(
    "/invites/accept",
    response_model=Token,
    dependencies=[
        Depends(RateLimiter(limiter=_auth_limiter_invite, identifier=ip_only_identifier)),
        Depends(RateLimiter(limiter=_auth_limiter_invite_account, identifier=auth_identifier)),
    ],
)
async def accept_invite(
    request: Request,
    response: Response,
    body: InviteAcceptRequest,
    invite_repo: InviteRepository = Depends(get_invite_repository),
):
    """Accept a pending invitation and create/login user.

    If the user already exists, this converts the pending invite to a share.
    If not, a new user is created (if registration is enabled or this is first boot).
    """
    from app.features.auth.service import InviteService

    invite_service = InviteService(invite_repo, auth_module)
    try:
        user_record = await invite_service.accept_invite(
            token=body.token,
            password=body.password,
            name=body.name,
        )
    except ValueError as e:
        detail = str(e)
        if "expired" in detail.lower():
            raise HTTPException(status_code=410, detail=detail) from e
        raise HTTPException(status_code=404, detail=detail) from e
    except RegistrationDisabledError as e:
        raise HTTPException(status_code=403, detail=e.message) from e
    except PasswordRequiredError as e:
        raise HTTPException(status_code=400, detail=e.message) from e

    access_token = auth_module.create_token(user_record["id"], user_record["email"], user_record["role"])
    refresh_token = auth_module.generate_refresh_token()
    await auth_module.create_refresh_token_db(int(user_record["id"]), refresh_token, remember_me=body.remember_me)
    _set_refresh_cookie(response, refresh_token, remember_me=body.remember_me)
    _set_access_cookie(response, access_token)

    return {"access_token": access_token, "refresh_token": refresh_token, "token_type": "bearer", "user": user_record}


@router.post("/logout")
async def logout(response: Response) -> dict[str, bool]:
    """Log out by clearing authentication cookies."""
    _clear_auth_cookies(response)
    return {"success": True}


@router.get("/me", response_model=User)
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
        "is_active": user.is_active,
        "totp_enabled": user.totp_enabled,
    }


@router.get("/me/settings")
async def get_me_settings(
    user: User = Depends(get_current_user),
    settings_repo: SettingsRepository = Depends(get_settings_repository),
):
    """Get all settings for the current user."""
    return await settings_repo.get_user_settings(int(user.id))


@router.put("/me/settings/{key}")
async def set_me_setting(
    key: str,
    data: dict,
    user: User = Depends(get_current_user),
    settings_repo: SettingsRepository = Depends(get_settings_repository),
):
    """Set a single user setting."""
    await settings_repo.set_user_setting(int(user.id), key, data.get("value"), utc_now())
    return {"success": True}


@router.put("/me", response_model=User)
async def update_me(
    data: UserUpdate,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Update current user profile."""
    updated = await auth_module.update_user(
        user.id,
        name=data.name,
        surnames=data.surnames,
        profile_pic=data.profile_pic,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")
    return updated


_auth_limiter_change_password = per_ip_limiter(5, Duration.MINUTE)


@router.post(
    "/change-password",
    dependencies=[
        Depends(RateLimiter(limiter=_auth_limiter_change_password, identifier=ip_only_identifier)),
        Depends(RateLimiter(limiter=_auth_limiter_change_password_account, identifier=auth_identifier)),
    ],
)
async def change_password(
    data: PasswordChangeRequest,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Change the current user's password.

    Invalidates all refresh tokens and API keys so that other sessions and
    devices must re-authenticate with the new password.
    """
    # Fetch the full user record including the password hash
    user_record = await auth_module.get_user_by_email(user.email)
    if not user_record:
        raise HTTPException(status_code=404, detail="User not found")

    try:
        current_ok = verify_password(data.current_password, user_record.get("hashed_password", ""))
    except PasswordVerificationError:
        logger.exception(f"Password verification error during change-password (user_id={user.id})")
        raise HTTPException(
            status_code=503,
            detail="Sign-in is temporarily unavailable. Please try again shortly.",
        ) from None

    if not current_ok:
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    updated = await auth_module.update_password(user.id, data.new_password)
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")

    user_id = int(user.id)
    await auth_module.revoke_all_user_refresh_tokens(user_id)
    await auth_module.revoke_all_user_api_keys(user_id)

    return {"success": True}


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
        result = await auth_module.create_api_key(
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
    keys = await auth_module.list_api_keys(int(user.id))
    return [ApiKeyResponse(**k) for k in keys]


@router.delete("/api-keys/{key_uuid}")
async def revoke_api_key_endpoint(
    key_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Revoke an API key."""
    success = await auth_module.revoke_api_key(int(user.id), key_uuid)
    if not success:
        raise HTTPException(status_code=404, detail="API key not found or already revoked")
    return {"success": True}


@router.post(
    "/api-keys/{key_uuid}/regenerate",
    response_model=ApiKeyCreateResponse,
    dependencies=[Depends(RateLimiter(limiter=_auth_limiter_api_key, identifier=ip_only_identifier))],
)
async def regenerate_api_key_endpoint(
    key_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Regenerate an existing API key's secret.

    Returns the new plaintext key **once** — copy it immediately.
    The key's name, scopes, and expiration date are preserved.
    """
    result = await auth_module.regenerate_api_key(int(user.id), key_uuid)
    if result is None:
        raise HTTPException(status_code=404, detail="API key not found or already revoked")
    return ApiKeyCreateResponse(**result)


@router.post("/device-token")
async def register_device_token(
    data: DeviceTokenRegisterRequest,
    user: User = Depends(get_current_user),  # noqa: B008
    push_device_repo: PushDeviceRepository = Depends(get_push_device_repository),
):
    """Register a mobile push notification device token for the current user."""
    await push_device_repo.register_token(int(user.id), data.token, data.platform)
    return {"success": True}


# ─── Two-Factor Authentication (TOTP) ─────────────────────────────


@router.post(
    "/2fa/setup",
    response_model=TwoFactorSetupResponse,
    dependencies=[Depends(RateLimiter(limiter=_auth_limiter_2fa))],
)
async def totp_setup(user: dict = Depends(require_full_or_setup_user)):  # noqa: B008
    """Start 2FA enrollment: create a pending secret and return the QR + manual key.

    The secret is stored encrypted but 2FA is not enabled until the user
    confirms with a valid code via /auth/2fa/enable. The plaintext secret and
    QR are returned once and are never written to disk or logs.
    """
    secret = totp.generate_secret()
    repo = await _user_repo()
    await repo.set_totp_secret(int(user["id"]), totp.encrypt_secret(secret))
    uri = totp.provisioning_uri(secret, user["email"])
    qr_svg = totp.generate_qr_svg(uri)
    return TwoFactorSetupResponse(otpauth_uri=uri, qr_svg=qr_svg, secret=secret)


@router.post(
    "/2fa/enable",
    dependencies=[Depends(RateLimiter(limiter=_auth_limiter_2fa))],
)
async def totp_enable(
    request: Request,
    response: Response,
    body: TwoFactorCodeRequest,
    user: dict = Depends(require_full_or_setup_user),  # noqa: B008
):
    """Confirm enrollment with a valid TOTP code and enable 2FA.

    On success, returns one-time backup codes (shown once) and issues full
    tokens, so an admin forced to enroll completes login in this step.
    """
    repo = await _user_repo()
    encrypted = await repo.get_totp_secret(int(user["id"]))
    if not encrypted:
        raise HTTPException(status_code=400, detail="No pending 2FA setup. Call /auth/2fa/setup first.")

    secret = totp.decrypt_secret(encrypted)
    if not totp.verify_code(secret, body.code):
        raise HTTPException(status_code=400, detail="Invalid authentication code")

    await repo.set_totp_enabled(int(user["id"]), True)
    codes = totp.generate_backup_codes()
    await repo.replace_backup_codes(int(user["id"]), [totp.hash_backup_code(c) for c in codes])
    auth_module.clear_user_cache(user["id"])
    # Refresh so the issued token payload reflects totp_enabled=True immediately.
    user = await auth_module.get_user_by_id(user["id"]) or {**user, "totp_enabled": True}

    tokens = await _issue_tokens(response, user)
    return {**tokens, "backup_codes": codes}


@router.post(
    "/2fa/verify",
    dependencies=[Depends(RateLimiter(limiter=_auth_limiter_2fa_verify, identifier=ip_only_identifier))],
)
async def totp_verify(response: Response, body: TwoFactorVerifyRequest):
    """Complete login by exchanging a pre-auth token + code for a full session.

    ``code`` may be a current 6-digit TOTP code or a one-time backup code.
    """
    payload = auth_module.decode_token(body.preauth_token)
    if not payload or payload.get("scope") not in {"2fa-verify", "2fa-setup"}:
        raise HTTPException(status_code=401, detail="Invalid or expired verification token")

    user_id = payload.get("user_id")
    user = await auth_module.get_user_by_id(user_id) if user_id else None
    if not user or not user.get("is_active", True):
        raise HTTPException(status_code=401, detail="Invalid or expired verification token")

    repo = await _user_repo()
    encrypted = await repo.get_totp_secret(int(user["id"]))
    if not encrypted:
        raise HTTPException(status_code=400, detail="Two-factor authentication is not enabled")

    secret = totp.decrypt_secret(encrypted)
    ok = totp.verify_code(secret, body.code)
    if not ok:
        for row in await repo.get_unused_backup_codes(int(user["id"])):
            if totp.verify_backup_code(body.code, row["code_hash"]):
                await repo.mark_backup_code_used(row["id"])
                ok = True
                break

    if not ok:
        raise HTTPException(status_code=401, detail="Invalid authentication code")

    return await _issue_tokens(response, user)


@router.post(
    "/2fa/disable",
    dependencies=[Depends(RateLimiter(limiter=_auth_limiter_2fa))],
)
async def totp_disable(
    body: TwoFactorDisableRequest,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Disable 2FA. Requires the current password or a valid code as proof."""
    if not body.current_password and not body.code:
        raise HTTPException(status_code=400, detail="Provide your current password or an authentication code")

    repo = await _user_repo()
    record = await auth_module.get_user_by_email(user.email)
    if not record:
        raise HTTPException(status_code=404, detail="User not found")

    if body.current_password:
        try:
            ok = verify_password(body.current_password, record.get("hashed_password", ""))
        except PasswordVerificationError:
            raise HTTPException(
                status_code=503,
                detail="Sign-in is temporarily unavailable. Please try again shortly.",
            ) from None
        if not ok:
            raise HTTPException(status_code=401, detail="Current password is incorrect")
    else:
        encrypted = await repo.get_totp_secret(int(user.id))
        ok = False
        if encrypted:
            secret = totp.decrypt_secret(encrypted)
            ok = totp.verify_code(secret, body.code or "")
            if not ok:
                for row in await repo.get_unused_backup_codes(int(user.id)):
                    if totp.verify_backup_code(body.code or "", row["code_hash"]):
                        await repo.mark_backup_code_used(row["id"])
                        ok = True
                        break
        if not ok:
            raise HTTPException(status_code=401, detail="Invalid authentication code")

    await repo.clear_totp(int(user.id))
    auth_module.clear_user_cache(user.id)
    return {"success": True}


@router.post(
    "/2fa/backup-codes/regenerate",
    response_model=TwoFactorEnableResponse,
    dependencies=[Depends(RateLimiter(limiter=_auth_limiter_2fa))],
)
async def totp_regenerate_backup_codes(
    body: TwoFactorCodeRequest,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Regenerate backup codes (requires a current TOTP code). Shown once."""
    if not user.totp_enabled:
        raise HTTPException(status_code=400, detail="Two-factor authentication is not enabled")

    repo = await _user_repo()
    encrypted = await repo.get_totp_secret(int(user.id))
    if not encrypted or not totp.verify_code(totp.decrypt_secret(encrypted), body.code):
        raise HTTPException(status_code=401, detail="Invalid authentication code")

    codes = totp.generate_backup_codes()
    await repo.replace_backup_codes(int(user.id), [totp.hash_backup_code(c) for c in codes])
    return TwoFactorEnableResponse(backup_codes=codes)
