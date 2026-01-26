"""Node domain entity.

The Node is the core entity of Notees. Everything is a node:
- Pages (nodes with is_page=1)
- Blocks (nodes with a parent_id, always have page_id set)
- Classes (nodes with is_class=1, define what kind of node something is)
- System nodes (day, month, year, task, template, etc. - indicated by is_* flags)

Nodes are identified by:
- id: Auto-incremental database primary key
- uuid: Public identifier for links, navigation, filtering

Class flags are stored directly on nodes for fast queries. They are NOT mutually exclusive.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, List, Any
from dataclasses import dataclass, field
import uuid as uuid_module


# Type alias for node IDs
NodeId = int


# Import from shared utility for consistency
from ...utils import utc_now, utc_now_iso


def generate_uuid() -> str:
    """Generate a new UUID."""
    return str(uuid_module.uuid4())


@dataclass
class Node:
    """Domain entity representing a node.
    
    This is the core domain object. All entities in the system are nodes.
    """
    # Identity - id is set by database, uuid is generated
    id: Optional[int] = None
    uuid: str = field(default_factory=generate_uuid)
    
    # Graph context (replaces workspace)
    graph_id: Optional[int] = None
    
    # Content
    name: str = ""  # The main content, contains [[page links]] and ((block refs))
    icon: Optional[str] = None  # Optional icon identifier
    color: Optional[str] = None  # Optional color for future use
    
    # Hierarchy
    parent_id: Optional[int] = None  # Parent node (NULL for root pages)
    page_id: Optional[int] = None  # Containing page (NULL for pages, computed for blocks)
    sequence: int = 0  # Order among siblings
    collapsed: bool = False  # UI state
    active: bool = True  # Whether node is active (soft-delete flag)
    is_shared: bool = False  # Whether this node is shared with other users
    
    # Class flags (stored for fast queries, not mutually exclusive)
    is_class: bool = False     # This node defines a class
    is_page: bool = False      # Regular page
    is_day: bool = False       # Daily journal page
    is_month: bool = False     # Monthly journal page
    is_year: bool = False      # Yearly journal page  
    is_asset: bool = False     # Asset/file block
    is_template: bool = False  # Template page
    is_comment: bool = False   # Comment block
    
    # Class-specific fields
    usable_in: str = "both"  # Where this class can be applied: 'page', 'block', or 'both'
    
    # Open date - when the page was last opened/viewed (NULL by default)
    open_date: Optional[str] = None
    
    # Audit - stored as ISO strings
    create_date: str = field(default_factory=utc_now_iso)
    write_date: str = field(default_factory=utc_now_iso)
    create_uid: Optional[int] = None  # User who created
    write_uid: Optional[int] = None  # User who last modified
    
    # Classes Path - inherited classes from ancestors (NOT for backlinks, used for queries)
    # This is the ordered list of class node IDs from ancestor's `classes` properties
    # e.g., a block inside a node classed `task`, inside a node classed `meeting` -> [task_id, meeting_id]
    classes_path: List[int] = field(default_factory=list)
    
    # Optimistic locking
    version: int = 1
    
    # Computed (not stored)
    _display_name: Optional[str] = field(default=None, repr=False)
    _classes: List[int] = field(default_factory=list, repr=False)  # Cached class node IDs
    
    @property
    def display_name(self) -> str:
        """Get display name (with optional hierarchy prefix)."""
        if self._display_name is not None:
            return self._display_name
        return self.name
    
    @display_name.setter
    def display_name(self, value: str) -> None:
        """Set computed display name."""
        self._display_name = value
    
    def is_block(self) -> bool:
        """Check if this node is a block (has parent_id)."""
        return self.parent_id is not None
    
    def touch(self, user_id: Optional[int] = None) -> None:
        """Update modification timestamp."""
        self.write_date = utc_now_iso()
        if user_id is not None:
            self.write_uid = user_id


@dataclass
class NodeCreateData:
    """Data required to create a new node."""
    name: str = ""
    icon: Optional[str] = None
    color: Optional[str] = None
    parent_id: Optional[int] = None
    sequence: int = 0
    collapsed: bool = False
    classes: List[int] = field(default_factory=list)  # Class node IDs to apply
    property_values: dict = field(default_factory=dict)  # property_id -> value
    # Class flags (optional - can be set explicitly or derived from classes)
    is_class: bool = False
    is_page: bool = False
    is_day: bool = False
    is_month: bool = False
    is_year: bool = False
    is_asset: bool = False
    is_template: bool = False
    is_comment: bool = False


@dataclass
class NodeUpdateData:
    """Data for updating an existing node."""
    name: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    # Explicit clear flags for nullable fields (when None means "clear" vs "unchanged")
    clear_icon: bool = False
    clear_color: bool = False
    parent_id: Optional[int] = None
    sequence: Optional[int] = None
    collapsed: Optional[bool] = None
    classes: Optional[List[int]] = None
    property_values: Optional[dict] = None
    # Class flags (optional)
    is_class: Optional[bool] = None
    is_page: Optional[bool] = None
    is_day: Optional[bool] = None
    is_month: Optional[bool] = None
    is_year: Optional[bool] = None
    is_asset: Optional[bool] = None
    is_template: Optional[bool] = None
    is_comment: Optional[bool] = None
