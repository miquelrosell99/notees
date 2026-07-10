"""Database models and Pydantic schemas for Notees.

The core data model is the Node. Everything is a node with different types:
- page: A page node that can contain blocks and other pages
- block: A block node within a page or another block
- tag: A tag node for categorization

Nodes have:
- uuid: Stable unique identifier
- name: UUID for blocks, title for pages (unique within parent)
- display_name: Human-readable name (formatted date for journals)
- parent_id: Points to parent node for hierarchy

Pages reference other pages with [[Page Name]], blocks with ((block-uuid)).
Journal pages use tags: 'day', 'month', 'year' with YYYYMMdd format names.
"""

from datetime import datetime
from typing import TypeVar

from pydantic import BaseModel, field_validator
from uuid_extensions import uuid7

# Sync DTOs are defined in the domain layer; re-export them here for the API.
from app.domain.entities.sync import (  # noqa: F401
    ClientNodeState,
    ServerNodeState,
    SyncConflict,
    SyncRequest,
    SyncResponse,
)


def _validate_password_strength(v: str | None) -> str | None:
    """Shared password complexity validator.

    Enforces length (8-128), uppercase, lowercase, digit, and special character
    requirements. Returns None unchanged so it can be used on optional fields.
    """
    if v is None:
        return v
    if len(v) < 8:
        raise ValueError("Password must be at least 8 characters")
    if len(v) > 128:
        raise ValueError("Password must be at most 128 characters")
    if not any(c.isupper() for c in v):
        raise ValueError("Password must contain at least one uppercase letter")
    if not any(c.islower() for c in v):
        raise ValueError("Password must contain at least one lowercase letter")
    if not any(c.isdigit() for c in v):
        raise ValueError("Password must contain at least one digit")
    if not any(c in "!@#$%^&*()_+-=[]{}|;':\",./<>?`~" for c in v):
        raise ValueError("Password must contain at least one special character")
    return v


def _validate_admin_password_strength(v: str | None) -> str | None:
    """Admin password complexity validator.

    Admin-created accounts use the stricter 12-character baseline applied to
    ``ADMIN_PASSWORD``. Reuses the user password checks after enforcing the
    admin minimum length.
    """
    if v is None:
        return v
    if len(v) < 12:
        raise ValueError("Admin password must be at least 12 characters")
    return _validate_password_strength(v)


def generate_uuid() -> str:
    """Generate a unique UUIDv7 for public identifiers.

    UUIDv7 is time-ordered and DB-friendly, giving better index locality than
    v4 for the document model (nodes, blocks, graph edges).
    """
    return str(uuid7())


# Re-exported from the feature-first export module for backward compatibility.


# ==================== USER MODELS ====================


class UserBase(BaseModel):
    """Base user model."""

    email: str


class UserCreate(UserBase):
    """User creation model."""

    password: str
    name: str | None = None
    surnames: str | None = None
    profile_pic: str | None = None
    remember_me: bool = False
    admin_password: str | None = None
    """Configured ADMIN_PASSWORD; required only when creating the first admin."""

    @field_validator("email")
    @classmethod
    def validate_email(cls, v):
        if len(v) < 3:
            raise ValueError("Email must be at least 3 characters")
        if len(v) > 255:
            raise ValueError("Email must be at most 255 characters")
        if "@" not in v:
            raise ValueError("Invalid email address")
        return v

    @field_validator("password")
    @classmethod
    def validate_password(cls, v):
        return _validate_password_strength(v)


class UserLogin(UserBase):
    """User login model."""

    password: str
    remember_me: bool = False


class UserUpdate(BaseModel):
    """User self-service update model."""

    name: str | None = None
    surnames: str | None = None
    profile_pic: str | None = None


class PasswordChangeRequest(BaseModel):
    """User self-service password change request."""

    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def validate_new_password(cls, v):
        return _validate_password_strength(v)


class DeviceTokenRegisterRequest(BaseModel):
    """Mobile push notification device token registration."""

    token: str
    platform: str = "unknown"


class AdminUserCreate(UserCreate):
    """Admin user creation model. Uses the stricter admin password baseline."""

    role: str = "user"
    active: bool = True

    @field_validator("password")
    @classmethod
    def validate_admin_password(cls, v):
        return _validate_admin_password_strength(v)


class AdminUserUpdate(BaseModel):
    """Admin user update model."""

    email: str | None = None
    password: str | None = None
    name: str | None = None
    surnames: str | None = None
    profile_pic: str | None = None
    role: str | None = None
    active: bool | None = None

    @field_validator("password")
    @classmethod
    def validate_password(cls, v):
        return _validate_password_strength(v)


class User(UserBase):
    """Full user model."""

    id: str
    uuid: str
    name: str | None = None
    surnames: str | None = None
    profile_pic: str | None = None
    role: str = "user"
    created_at: datetime
    is_active: bool = True
    totp_enabled: bool = False
    scopes: list[str] | None = None

    class Config:
        from_attributes = True


class UserInDB(User):
    """User model with hashed password (internal use)."""

    hashed_password: str


class Token(BaseModel):
    """JWT token response with refresh token."""

    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: User


class AccessTokenResponse(BaseModel):
    """JWT access-token-only response (refresh rotation)."""

    access_token: str
    token_type: str = "bearer"


class TwoFactorSetupResponse(BaseModel):
    """TOTP enrollment response: otpauth URI, QR SVG, and one-time base32 secret."""

    otpauth_uri: str
    qr_svg: str
    secret: str  # base32, for manual entry; shown once at enrollment


class TwoFactorCodeRequest(BaseModel):
    """TOTP code submission (6-digit TOTP code or a backup code)."""

    code: str  # 6-digit TOTP code or a backup code


class TwoFactorEnableResponse(BaseModel):
    """TOTP enable response carrying the freshly generated backup codes."""

    backup_codes: list[str]


class TwoFactorVerifyRequest(BaseModel):
    """Second-step login verification using a pre-auth token and a code."""

    preauth_token: str
    code: str


class TwoFactorDisableRequest(BaseModel):
    """TOTP disable request; requires current password and/or a valid code."""

    current_password: str | None = None
    code: str | None = None


class TwoFactorRequiredResponse(BaseModel):
    """Login response indicating a second factor is required."""

    requires_2fa: bool = True
    preauth_token: str
    purpose: str  # "verify" (enter TOTP) or "setup" (admin must enroll)


class TokenData(BaseModel):
    """Token payload data."""

    user_id: str
    username: str


# ==================== API KEY MODELS ====================


class ApiKeyCreate(BaseModel):
    """API key creation request."""

    name: str

    @field_validator("name")
    @classmethod
    def validate_name(cls, v):
        if len(v) < 1:
            raise ValueError("Name is required")
        if len(v) > 255:
            raise ValueError("Name must be at most 255 characters")
        return v


class ApiKeyResponse(BaseModel):
    """API key response (list view — no plaintext key)."""

    id: str
    name: str
    scopes: list[str]
    last_4: str | None = None
    last_used_at: datetime | None = None
    revoked: bool
    created_at: datetime
    expires_at: datetime | None = None

    class Config:
        from_attributes = True


class ApiKeyCreateResponse(ApiKeyResponse):
    """API key creation response — includes plaintext key once."""

    key: str


# ==================== PAGINATION ====================

T = TypeVar("T")


class ErrorDetail(BaseModel):
    """Standardized error detail for API responses."""

    code: str
    message: str
    status: int


class ErrorResponse(BaseModel):
    """Standardized error response envelope."""

    error: ErrorDetail


class PaginatedResponse[T](BaseModel):
    """Generic paginated response for list endpoints."""

    items: list[T]
    total: int
    page: int
    page_size: int
    has_next: bool
    has_prev: bool


# ==================== WORKSPACE MODELS ====================


class WorkspaceCreate(BaseModel):
    """Create workspace request."""

    name: str


# ==================== EXPORT MODELS ====================


# ==================== SETTINGS MODELS ====================


class InviteAcceptRequest(BaseModel):
    """Accept a pending invitation."""

    token: str
    password: str | None = None
    name: str | None = None
    remember_me: bool = False

    @field_validator("password")
    @classmethod
    def validate_password(cls, v):
        return _validate_password_strength(v)


class NotificationResponse(BaseModel):
    """Notification item."""

    id: str
    notification_uuid: str
    type: str
    actor_user_id: str | None = None
    actor_name: str | None = None
    node_id: str | None = None
    node_name: str | None = None
    message: str | None = None
    is_read: bool
    create_date: datetime


class UserSettings(BaseModel):
    """User settings."""

    date_format: str = "YYYY-MM-DD"
    default_database: str | None = None
    first_day_of_week: int = 0  # 0 = Sunday, 1 = Monday, 6 = Saturday
