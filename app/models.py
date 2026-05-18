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
from typing import Optional, List, Generic, TypeVar
from pydantic import BaseModel, Field, field_validator
from enum import Enum
import uuid
import re


def generate_uuid() -> str:
    """Generate a unique UUID for nodes."""
    return str(uuid.uuid4())


class ExportFormat(str, Enum):
    """Export formats."""
    MARKDOWN = "markdown"
    HTML = "html"
    PDF = "pdf"


# ==================== USER MODELS ====================

class UserBase(BaseModel):
    """Base user model."""
    username: str


class UserCreate(UserBase):
    """User creation model."""
    password: str
    
    @field_validator('username')
    @classmethod
    def validate_username(cls, v):
        if len(v) < 3:
            raise ValueError('Username must be at least 3 characters')
        if len(v) > 50:
            raise ValueError('Username must be at most 50 characters')
        if not re.match(r'^[a-zA-Z0-9_]+$', v):
            raise ValueError('Username can only contain letters, numbers, and underscores')
        return v
    
    @field_validator('password')
    @classmethod
    def validate_password(cls, v):
        if len(v) < 8:
            raise ValueError('Password must be at least 8 characters')
        if len(v) > 128:
            raise ValueError('Password must be at most 128 characters')
        return v


class UserLogin(UserBase):
    """User login model."""
    password: str


class User(UserBase):
    """Full user model."""
    id: str
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


# ==================== PAGINATION ====================

T = TypeVar('T')

class PaginatedResponse(BaseModel, Generic[T]):
    """Generic paginated response for list endpoints."""
    items: List[T]
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
    last_sync: Optional[datetime] = None
    nodes: List[dict] = []
    deleted_nodes: List[str] = []


class SyncResponse(BaseModel):
    """Response from sync."""
    server_time: datetime
    nodes: List[dict] = []
    deleted_nodes: List[str] = []
    conflicts: List[dict] = []


# ==================== EXPORT MODELS ====================

class ExportRequest(BaseModel):
    """Export request."""
    node_ids: List[str]
    format: ExportFormat
    include_children: bool = True
    include_backlinks: bool = False


class ExportResponse(BaseModel):
    """Export response."""
    content: str
    filename: str
    mime_type: str


# ==================== SETTINGS MODELS ====================

class UserSettings(BaseModel):
    """User settings."""
    date_format: str = "YYYY-MM-DD"
    theme: str = "light"
    default_database: Optional[str] = None
    first_day_of_week: int = 0  # 0 = Sunday, 1 = Monday, 6 = Saturday



