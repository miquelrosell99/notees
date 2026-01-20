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
from typing import Optional, List
from pydantic import BaseModel, Field
from enum import Enum
import uuid


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


# ==================== NODE MODELS ====================

class NodeBase(BaseModel):
    """Base node model - the foundation of the system.
    
    Properties:
    - uuid: Stable unique identifier
    - name: UUID for blocks, title for pages (unique within parent hierarchy)
    - display_name: Human-readable name for display (date format for journals)
    - parent_id: Establishes hierarchy
    - page_id: Reference to the containing page (for blocks)
    - tags: Special tags like 'day', 'month', 'year', 'task', 'template', 'property' for journals and types
    - Audit fields: create_date, create_uid, write_date, write_uid
    """
    name: Optional[str] = None  # UUID for blocks, title for pages
    display_name: Optional[str] = None  # Human-readable name
    content: str = ""  # Block content or page description
    title: Optional[str] = None  # Page title (for pages)
    parent_id: Optional[str] = None
    page_id: Optional[str] = None  # Reference to containing page (for blocks)
    order: int = 0
    collapsed: bool = False
    tags: List[str] = []  # Type tags: day, month, year, task, template, property, etc.
    properties: dict = {}  # Custom properties and user-defined attributes
    
    # Node type flags
    is_page: bool = False
    is_tag: bool = False
    is_property: bool = False
    is_template: bool = False
    is_task: bool = False
    is_system: bool = False
    is_daily: bool = False  # For daily journal pages
    is_monthly: bool = False
    is_yearly: bool = False
    daily_date: Optional[str] = None  # YYYY-MM-DD for daily pages


class NodeCreate(NodeBase):
    """Node creation model."""
    id: Optional[str] = None
    uuid: Optional[str] = None
    page_id: Optional[str] = None


class NodeUpdate(BaseModel):
    """Node update model - all fields optional."""
    name: Optional[str] = None
    display_name: Optional[str] = None
    content: Optional[str] = None
    title: Optional[str] = None
    parent_id: Optional[str] = None
    page_id: Optional[str] = None
    order: Optional[int] = None
    collapsed: Optional[bool] = None
    tags: Optional[List[str]] = None
    properties: Optional[dict] = None


class Node(NodeBase):
    """Full node model."""
    id: str
    uuid: str
    page_id: Optional[str] = None  # Reference to containing page
    created_at: datetime  # Alias for create_date
    updated_at: datetime  # Alias for write_date
    create_uid: Optional[str] = None  # User who created the node
    write_uid: Optional[str] = None  # User who last modified the node
    version: int = 1

    class Config:
        from_attributes = True


class NodeWithChildren(Node):
    """Node with its children for tree views."""
    children: List["NodeWithChildren"] = []


class NodeWithContext(Node):
    """Node with additional context."""
    parent_title: Optional[str] = None
    children_count: int = 0
    backlinks_count: int = 0


# ==================== DATABASE MODELS ====================

class DatabaseInfo(BaseModel):
    """Database/graph information."""
    name: str
    filename: str
    created_at: datetime
    updated_at: datetime
    size_bytes: int = 0
    node_count: int = 0
    page_count: int = 0
    is_active: bool = False
    user_id: Optional[str] = None


class DatabaseCreate(BaseModel):
    """Create database request."""
    name: str


class DatabaseImport(BaseModel):
    """Import database request."""
    name: str
    # File will be uploaded separately


# ==================== SYNC MODELS ====================

class SyncRequest(BaseModel):
    """Request for syncing data."""
    last_sync: Optional[datetime] = None
    nodes: List[dict] = []
    deleted_nodes: List[str] = []


class SyncResponse(BaseModel):
    """Response from sync."""
    server_time: datetime
    nodes: List[Node] = []
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


# Enable forward references for recursive model
NodeWithChildren.model_rebuild()
