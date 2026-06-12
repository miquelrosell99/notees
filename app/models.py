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

import uuid
from datetime import datetime
from enum import StrEnum
from typing import TypeVar

from pydantic import BaseModel, field_validator


def generate_uuid() -> str:
    """Generate a unique UUID for nodes."""
    return str(uuid.uuid4())


class ExportFormat(StrEnum):
    """Export formats."""

    MARKDOWN = "markdown"
    HTML = "html"
    PDF = "pdf"
    TEXT = "text"
    JSON = "json"


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


class UserLogin(UserBase):
    """User login model."""

    password: str


class UserUpdate(BaseModel):
    """User self-service update model."""

    name: str | None = None
    surnames: str | None = None
    profile_pic: str | None = None


class AdminUserCreate(UserCreate):
    """Admin user creation model. Reuses email/password validators from UserCreate."""

    role: str = "user"
    active: bool = True


class AdminUserUpdate(BaseModel):
    """Admin user update model."""

    email: str | None = None
    password: str | None = None
    name: str | None = None
    surnames: str | None = None
    profile_pic: str | None = None
    role: str | None = None
    active: bool | None = None


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


# ==================== SYNC MODELS ====================


class ClientNodeState(BaseModel):
    """Client-side node state sent during sync."""

    uuid: str
    version: int
    name: str | None = None
    parent_id: str | None = None
    sequence: float | None = None
    is_deleted: bool = False


class SyncRequest(BaseModel):
    """Request for syncing data."""

    last_sync: datetime | None = None
    client_nodes: list[ClientNodeState] = []
    workspace_uuid: str | None = None


class ServerNodeState(BaseModel):
    """Server-side node state returned during sync."""

    uuid: str
    version: int
    name: str | None = None
    parent_id: str | None = None
    sequence: float | None = None
    is_deleted: bool = False
    write_date: datetime | None = None


class SyncConflict(BaseModel):
    """Conflict detected during sync."""

    uuid: str
    server_version: int
    client_version: int
    server_node: ServerNodeState | None = None
    reason: str


class SyncResponse(BaseModel):
    """Response from sync."""

    server_time: datetime
    server_nodes: list[ServerNodeState] = []
    deleted_node_uuids: list[str] = []
    conflicts: list[SyncConflict] = []


# ==================== EXPORT MODELS ====================


class ExportRequest(BaseModel):
    """Export request."""

    node_ids: list[str]
    format: ExportFormat
    include_children: bool = True
    include_backlinks: bool = False
    layout: str = "outline"
    formatting: bool = True
    style: str | None = None
    properties: str = "none"
    density: str = "comfortable"
    numbering: str = "none"
    measure: str = "full"
    doctype: str = "none"
    section_break: bool = False
    show_uuid: bool = False
    link_style: str = "raw"
    theme_mode: str = "light"
    cover_page: bool = False

    @field_validator("layout")
    @classmethod
    def validate_layout(cls, v):
        if v not in {"outline", "flat", "document", "table"}:
            raise ValueError("layout must be one of: outline, flat, document, table")
        return v

    @field_validator("properties")
    @classmethod
    def validate_properties(cls, v):
        if v not in {"none", "main", "all"}:
            raise ValueError("properties must be one of: none, main, all")
        return v

    @field_validator("density")
    @classmethod
    def validate_density(cls, v):
        if v not in {"comfortable", "compact", "spacious"}:
            raise ValueError("density must be one of: comfortable, compact, spacious")
        return v

    @field_validator("numbering")
    @classmethod
    def validate_numbering(cls, v):
        if v not in {"none", "decimal", "bullet", "checklist"}:
            raise ValueError("numbering must be one of: none, decimal, bullet, checklist")
        return v

    @field_validator("measure")
    @classmethod
    def validate_measure(cls, v):
        if v not in {"full", "compact", "minimal"}:
            raise ValueError("measure must be one of: full, compact, minimal")
        return v

    @field_validator("doctype")
    @classmethod
    def validate_doctype(cls, v):
        if v not in {"none", "article", "report", "letter", "book"}:
            raise ValueError("doctype must be one of: none, article, report, letter, book")
        return v

    @field_validator("link_style")
    @classmethod
    def validate_link_style(cls, v):
        if v not in {"raw", "wiki", "markdown"}:
            raise ValueError("link_style must be one of: raw, wiki, markdown")
        return v

    @field_validator("theme_mode")
    @classmethod
    def validate_theme_mode(cls, v):
        if v not in {"light", "dark", "auto"}:
            raise ValueError("theme_mode must be one of: light, dark, auto")
        return v


class ExportResponse(BaseModel):
    """Export response."""

    content: str
    filename: str
    mime_type: str


# ==================== SETTINGS MODELS ====================


class InviteAcceptRequest(BaseModel):
    """Accept a pending invitation."""

    token: str
    password: str | None = None
    name: str | None = None


class NotificationResponse(BaseModel):
    """Notification item."""

    id: str
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
