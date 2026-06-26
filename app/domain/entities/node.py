"""Node domain entity.

Notees
Copyright (C) 2026 Miquel Rosell Tarragó

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, version 3.

See the LICENSE file for details.

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

from dataclasses import dataclass, field

from uuid_extensions import uuid7

from ...utils import utc_now_iso

# Type alias for node IDs
NodeId = int


def generate_uuid() -> str:
    """Generate a new UUIDv7 for public identifiers.

    UUIDv7 is time-ordered and DB-friendly, giving better index locality than
    v4 for the document model (nodes, blocks, graph edges).
    """
    return str(uuid7())


@dataclass
class Node:
    """Domain entity representing a node.

    This is the core domain object. All entities in the system are nodes.
    """

    # Identity - id is set by database, uuid is generated
    id: int | None = None
    uuid: str = field(default_factory=generate_uuid)

    # Workspace context (replaces workspace)
    workspace_id: int | None = None

    # Content
    name: str = ""  # The main content, contains [[page links]] and ((block refs))
    icon: str | None = None  # Optional icon identifier
    color: str | None = None  # Optional color for future use

    # Hierarchy
    parent_id: int | None = None  # Parent node (NULL for root pages)
    page_id: int | None = None  # Containing page (NULL for pages, computed for blocks)
    sequence: float = 0.0  # Order among siblings
    active: bool = True  # Whether node is active (soft-delete flag)
    is_shared: bool = False  # Whether this node is shared with other users
    is_private: bool = False  # If true, only the owner can access this node

    # Soft delete
    is_deleted: bool = False  # Whether node is deleted (trash)
    deleted_at: str | None = None  # When the node was deleted (ISO string)

    # Class flags (stored for fast queries, not mutually exclusive)
    is_class: bool = False  # This node defines a class
    is_page: bool = False  # Regular page
    is_day: bool = False  # Daily journal page
    is_month: bool = False  # Monthly journal page
    is_year: bool = False  # Yearly journal page
    is_asset: bool = False  # Asset/file block
    asset_file_id: int | None = None  # Content-addressed file backing this asset
    is_template: bool = False  # Template page
    is_comment: bool = False  # Comment block
    is_task: bool = False  # Task item (synchronized with task class assignment)
    is_table: bool = False  # Table block (synchronized with table class assignment)
    is_card: bool = False  # Flashcard/quiz card (synchronized with card class assignment)
    is_cloze: bool = False  # Cloze deletion block (child of a card)

    # Parent lock - prevents parent_id from being changed
    parent_locked: bool = False

    # Alias support - if set, this node is an alias of the node with this ID
    aliased_id: int | None = None  # The main node this page aliases

    # Open date - when the page was last opened/viewed (NULL by default)
    open_date: str | None = None

    # Audit - stored as ISO strings
    create_date: str = field(default_factory=utc_now_iso)
    write_date: str = field(default_factory=utc_now_iso)
    create_uid: int | None = None  # User who created
    write_uid: int | None = None  # User who last modified

    # Classes Path - inherited classes from ancestors (NOT for backlinks, used for queries)
    # This is the ordered list of class node IDs from ancestor's `classes` properties
    # e.g., a block inside a node classed `task`, inside a node classed `meeting` -> [task_id, meeting_id]
    classes_path: list[int] = field(default_factory=list)

    # Direct class assignments (replaces property-based storage)
    class_ids: list[int] = field(default_factory=list)

    # Direct tag assignments (replaces node_link.is_tag storage)
    tag_ids: list[int] = field(default_factory=list)

    # Optimistic locking
    version: int = 1

    # Computed (not stored)
    _display_name: str | None = field(default=None, repr=False)

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

    def touch(self, user_id: int | None = None) -> None:
        """Update modification timestamp."""
        self.write_date = utc_now_iso()
        if user_id is not None:
            self.write_uid = user_id


@dataclass
class NodeCreateData:
    """Data required to create a new node."""

    name: str = ""
    icon: str | None = None
    color: str | None = None
    parent_id: int | None = None
    sequence: float = 0.0
    classes: list[int] = field(default_factory=list)  # Class node IDs to apply
    tags: list[int] = field(default_factory=list)  # Tag node IDs to apply
    property_values: dict = field(default_factory=dict)  # property_id -> value
    uuid: str | None = None  # Optional: override auto-generated UUID (for assets)
    asset_file_id: int | None = None  # Content-addressed file for asset nodes
    is_page: bool = False
    is_task: bool = False
    is_daily: bool = False
    is_monthly: bool = False
    is_yearly: bool = False


@dataclass
class NodeUpdateData:
    """Data for updating an existing node."""

    name: str | None = None
    icon: str | None = None
    color: str | None = None
    # Explicit clear flags for nullable fields (when None means "clear" vs "unchanged")
    clear_icon: bool = False
    clear_color: bool = False
    clear_parent: bool = False
    parent_id: int | None = None
    sequence: float | None = None
    is_private: bool | None = None
    classes: list[int] | None = None
    property_values: dict | None = None
    expected_version: int | None = None
