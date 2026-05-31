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
from enum import Enum
from typing import Generic, TypeVar

from pydantic import BaseModel, field_validator


def generate_uuid() -> str:
    """Generate a unique UUID for nodes."""
    return str(uuid.uuid4())


class ExportFormat(str, Enum):
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
        return v


class UserLogin(UserBase):
    """User login model."""

    password: str


class UserUpdate(BaseModel):
    """User self-service update model."""

    name: str | None = None
    surnames: str | None = None
    profile_pic: str | None = None


class AdminUserCreate(UserBase):
    """Admin user creation model."""

    password: str
    name: str | None = None
    surnames: str | None = None
    profile_pic: str | None = None
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
    """JWT token response."""

    access_token: str
    token_type: str = "bearer"
    user: User


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
    last_used_at: datetime | None = None
    revoked: bool
    created_at: datetime

    class Config:
        from_attributes = True


class ApiKeyCreateResponse(ApiKeyResponse):
    """API key creation response — includes plaintext key once."""

    key: str


# ==================== PAGINATION ====================

T = TypeVar("T")


class PaginatedResponse(BaseModel, Generic[T]):
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


class SyncRequest(BaseModel):
    """Request for syncing data."""

    last_sync: datetime | None = None
    nodes: list[dict] = []
    deleted_nodes: list[str] = []


class SyncResponse(BaseModel):
    """Response from sync."""

    server_time: datetime
    nodes: list[dict] = []
    deleted_nodes: list[str] = []
    conflicts: list[dict] = []


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


class ExportResponse(BaseModel):
    """Export response."""

    content: str
    filename: str
    mime_type: str


# ==================== SETTINGS MODELS ====================


class UserSettings(BaseModel):
    """User settings."""

    date_format: str = "YYYY-MM-DD"
    default_database: str | None = None
    first_day_of_week: int = 0  # 0 = Sunday, 1 = Monday, 6 = Saturday
