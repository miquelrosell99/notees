"""Pydantic models for the Nodes API."""

from typing import Any

from pydantic import BaseModel, Field


class BatchTextLinksRequest(BaseModel):
    """Request body for batch text-link resolution."""

    node_ids: list[int]


class SetFavoritesRequest(BaseModel):
    """Request body for replacing the favorites list."""

    favorites: list[int]


class ReorderFavoritesRequest(BaseModel):
    """Request body for reordering favorites."""

    from_index: int = Field(..., ge=0)
    to_index: int = Field(..., ge=0)


class NodeResponse(BaseModel):
    """Node response model."""

    id: int
    uuid: str
    name: str
    icon: str | None = None
    color: str | None = None
    parent_id: int | None = None
    page_id: int | None = None
    sequence: float = 0.0
    collapsed: bool = False
    active: bool = True
    is_page: bool = False  # Whether this node is a page
    is_class: bool = False  # Whether this node defines a class
    is_daily: bool = False  # Daily journal page
    is_monthly: bool = False  # Monthly journal page
    is_yearly: bool = False  # Yearly journal page
    is_task: bool = False  # Task item (synchronized with task class assignment)
    is_table: bool = False  # Table block (synchronized with table class assignment)
    is_comment: bool = False  # Whether this node is a comment
    is_asset: bool = False  # Asset/file block (synchronized with asset class assignment)
    is_template: bool = False  # Template page (synchronized with template class assignment)
    is_card: bool = False  # Flashcard/quiz card (synchronized with card class assignment)
    parent_locked: bool = False  # Whether this node's parent is locked
    is_private: bool = False  # If true, only the owner can access this node
    create_date: str
    write_date: str
    open_date: str | None = None  # When the page was last opened/viewed
    # Computed fields
    display_name: str | None = None
    tags: list[int] = []  # Tag node IDs (descriptive linking with #)
    classes: list[int] = []  # Class node IDs (categorization with @)
    properties: dict[str, Any] = {}
    # Linked references - classes_path (inherited classes from ancestors)
    classes_path: list[int] = []  # Inherited class node IDs from ancestors' classes properties
    # For tree responses
    children: list["NodeResponse"] | None = None
    has_children: bool = False  # True if node has children (even if not loaded, e.g. collapsed)
    # Backlinks
    backlinks: list["BacklinkResponse"] | None = None
    linked_references: list["LinkedReferenceResponse"] | None = None
    backlink_count: int = 0  # Count of backlinks to this node
    # Comments
    comment_count: int = 0
    # Alias support
    aliased_id: int | None = None  # If set, this node is an alias of the node with this ID
    aliases: list[int] = []  # IDs of nodes that are aliases of this node
    # Class extension (Extends chain) - parent class IDs in order
    extends: list[int] = []
    # Referenced nodes map — uuid → node data for outgoing link targets.
    # Populated by page content endpoint so inline links resolve without N+1 queries.
    referenced_nodes: dict[str, "NodeResponse"] | None = None
    # Resolved permissions for the current user on this node.
    # Only populated for top-level node fetches, not batch/list responses.
    permissions: dict[str, bool] | None = None

    class Config:
        from_attributes = True


class BreadcrumbSegment(BaseModel):
    """A segment in the breadcrumb path."""

    node_id: int | None = None  # None for property segments
    name: str
    is_property: bool = False  # True if this is a property name segment


class BacklinkResponse(BaseModel):
    """Backlink info with full provenance.

    For text links: source is the block T containing [[id]]
    For property links: source is the property owner B
    """

    source_node_id: int
    source_node_uuid: str
    source_node_name: str
    source_is_page: bool = False
    source_page_id: int | None = None
    source_page_name: str | None = None
    source_page_uuid: str | None = None
    # Property info (for node-type property links)
    property_id: int | None = None
    property_name: str | None = None
    # Breadcrumb path with property provenance
    breadcrumb_path: list[BreadcrumbSegment] = []
    link_type: str  # "text" or "property"
    position: int


class LinkedReferenceResponse(BaseModel):
    """Linked reference with context."""

    source_node: NodeResponse
    source_page: NodeResponse | None = None
    link_type: str
    context: str  # Text around the link
    breadcrumb_path: list[BreadcrumbSegment] = []  # Path from source to page
    # For property-type links
    property_id: int | None = None
    property_name: str | None = None
    # For text-property-context links: root block ID of the text property
    text_property_root_block_id: int | None = None


class PropertyValueResponse(BaseModel):
    """Property value for a node."""

    property_id: int
    property_name: str
    property_type: str
    value: Any
    display_value: str


class NodeCreateRequest(BaseModel):
    """Request to create a node."""

    name: str = ""
    icon: str | None = None
    color: str | None = None
    parent_id: int | None = None
    sequence: float = 0.0
    classes: list[int] = []  # Class node IDs - flags are computed from these
    tags: list[int] = []  # Tag node IDs
    properties: dict[int, Any] = {}  # property_id -> value
    uuid: str | None = None  # Optional: override auto-generated UUID (e.g. from Logseq import)
    # For date nodes
    is_daily: bool = False
    daily_date: str | None = None  # YYYY-MM-DD
    is_monthly: bool = False
    monthly_date: str | None = None  # YYYY-MM
    is_yearly: bool = False
    yearly_date: str | None = None  # YYYY


class NodeUpdateRequest(BaseModel):
    """Request to update a node."""

    name: str | None = None
    icon: str | None = None
    color: str | None = None
    parent_id: int | None = None
    sequence: float | None = None
    collapsed: bool | None = None
    is_private: bool | None = None
    # Optional: when provided, reconcile node classes to exactly this set
    classes: list[int] | None = None
    # Optional: when provided, apply each property_id -> value pair
    properties: dict[int, Any] | None = None
    # Optional: when provided, update fails if node's version doesn't match (optimistic locking)
    expected_version: int | None = None


class ClassRequest(BaseModel):
    """Request to add/remove a class."""

    class_node_id: int


class PropertyRequest(BaseModel):
    """Request to set a property value."""

    property_id: int
    value: Any


class MoveNodeRequest(BaseModel):
    """Request to move a node to a new parent and/or position."""

    parent_id: int | None = None
    position: float | None = None


class TagLinkRequest(BaseModel):
    """Request to add a tag link."""

    target_node_id: int


class NodeLinkResponse(BaseModel):
    """Response for a node link."""

    id: int
    uuid: str  # Unique identifier for this link instance
    source_node_id: int
    target_node_id: int
    position: int
    name: str | None = None  # Custom display text for the link


class InlineClassResponse(BaseModel):
    """Inline class reference in content."""

    class_node_id: int
    class_node_name: str
    class_node_icon: str | None = None
    position: int


class PropertyBacklinkResponse(BaseModel):
    """A page that references a target node via property."""

    source_page: NodeResponse
    property_id: int
    property_name: str


class MentionResponse(BaseModel):
    """An unlinked mention candidate for a target node."""

    id: int
    uuid: str
    source_node_id: int
    source_node_uuid: str
    source_node_name: str
    source_is_page: bool
    target_id: int
    match_text: str
    position: int
    is_ignored: bool = False


class CommentCreateRequest(BaseModel):
    """Request to create a comment on a node."""

    name: str = ""  # Initial comment content
    parent_comment_id: int | None = None  # If set, creates a reply to this comment


class AliasRequest(BaseModel):
    """Request to add an alias."""

    alias_node_id: int


class DateFormatUpdateRequest(BaseModel):
    """Request to update date format for all date nodes."""

    new_format: str  # e.g., "YYYY/MM/DD", "DD-MM-YYYY", etc.


# ==================== Batch Read Operations ====================


class BatchGetNodesRequest(BaseModel):
    """Request to fetch multiple nodes by ID in a single call."""

    ids: list[int]
    include_properties: bool = False


class BatchGetNodesResponse(BaseModel):
    """Response for batch node fetch."""

    nodes: dict[str, NodeResponse]  # Keyed by node ID (as string for JSON compat)


class BatchGetNodesByUuidRequest(BaseModel):
    """Request to fetch multiple nodes by UUID in a single call."""

    uuids: list[str]
    include_properties: bool = False


class BatchGetNodesByUuidResponse(BaseModel):
    """Response for batch node fetch by UUID."""

    nodes: dict[str, NodeResponse]  # Keyed by node UUID (as string for JSON compat)


class BreadcrumbItem(BaseModel):
    """A single breadcrumb in the ancestor chain."""

    id: int
    name: str
    display_name: str = ""
    icon: str | None = None
    is_page: bool = False
    parent_locked: bool = False
    is_property: bool = False
    property_id: int | None = None


class BreadcrumbsResponse(BaseModel):
    """Response for breadcrumbs endpoint."""

    breadcrumbs: list[BreadcrumbItem]


# ==================== Batch Write Operations ====================


class BatchNodeCreateItem(BaseModel):
    """A single node to create in a batch operation."""

    name: str = ""
    icon: str | None = None
    color: str | None = None
    parent_id: int | None = None
    sequence: float = 0.0
    classes: list[int] = []
    properties: dict[int, Any] = {}
    uuid: str | None = None  # Optional: provide a UUID (e.g. from Logseq)


class BatchNodeCreateRequest(BaseModel):
    """Request to create multiple nodes in a single batch."""

    nodes: list[BatchNodeCreateItem]
    uuid_conflict_mode: str = "block"  # 'block' | 'return_existing'


class BatchNodeCreateResultItem(BaseModel):
    """Result for a single node creation in a batch."""

    index: int  # Index in the request array
    success: bool
    node: NodeResponse | None = None
    error: str | None = None
    existing: bool = False  # True when an existing node was returned (uuid_conflict_mode)


class BatchNodeCreateResponse(BaseModel):
    """Response for batch node creation."""

    results: list[BatchNodeCreateResultItem]
    created: int  # Count of successfully created nodes
    failed: int  # Count of failed nodes


class BatchNodeUpdateItem(BaseModel):
    """A single node update in a batch operation.

    Identifies the node by either id or uuid (at least one required).
    """

    id: int | None = None
    uuid: str | None = None
    name: str | None = None
    icon: str | None = None
    color: str | None = None
    parent_id: int | None = None
    sequence: float | None = None
    collapsed: bool | None = None
    # Optional: reconcile classes / apply property values in the same request
    classes: list[int] | None = None
    properties: dict[int, Any] | None = None


class BatchNodeUpdateRequest(BaseModel):
    """Request to update multiple nodes in a single batch."""

    nodes: list[BatchNodeUpdateItem]


class BatchNodeUpdateResultItem(BaseModel):
    """Result for a single node update in a batch."""

    index: int
    success: bool
    node: NodeResponse | None = None
    error: str | None = None


class BatchNodeUpdateResponse(BaseModel):
    """Response for batch node update."""

    results: list[BatchNodeUpdateResultItem]
    updated: int
    failed: int


class BatchNodeDeleteRequest(BaseModel):
    """Request to delete multiple nodes by UUID."""

    uuids: list[str]


class BatchNodeDeleteResultItem(BaseModel):
    """Result for a single node deletion in a batch."""

    index: int
    uuid: str
    success: bool
    error: str | None = None


class BatchNodeDeleteResponse(BaseModel):
    """Response for batch node deletion."""

    results: list[BatchNodeDeleteResultItem]
    deleted: int
    failed: int


class BatchPermanentDeleteRequest(BaseModel):
    """Request to permanently delete multiple nodes from trash."""

    ids: list[int]


class BatchPermanentDeleteResultItem(BaseModel):
    """Result for a single permanent node deletion in a batch."""

    index: int
    id: int
    success: bool
    error: str | None = None


class BatchPermanentDeleteResponse(BaseModel):
    """Response for batch permanent node deletion."""

    results: list[BatchPermanentDeleteResultItem]
    deleted: int
    failed: int


class BatchNodeDailyRequest(BaseModel):
    """Request to get-or-create multiple daily pages in one call."""

    dates: list[str]  # List of YYYY-MM-DD strings


class BatchNodeDailyResultItem(BaseModel):
    """Result for a single date in a batch daily request."""

    date: str
    success: bool
    node: NodeResponse | None = None
    error: str | None = None


class BatchNodeDailyResponse(BaseModel):
    """Response for batch daily get-or-create."""

    results: list[BatchNodeDailyResultItem]


# ==================== Template Operations ====================


class TemplateInstantiateRequest(BaseModel):
    """Request to instantiate a template node."""

    parent_id: int | None = None
    name: str | None = None
    variables: dict[str, str] = {}
    dynamic_context: dict[str, str] = {}  # Computed values for <% ... %> dynamic placeholders
    as_blocks: bool = False  # If True, create children under parent_id without a root page
    after_id: int | None = None  # Insert blocks after this sibling (as_blocks mode)


class TemplateInstantiateResponse(BaseModel):
    """Response from template instantiation."""

    node: NodeResponse | None = None  # The new root node (None when as_blocks=True)
    blocks: list[NodeResponse] = []  # The created blocks (populated when as_blocks=True)
    as_blocks: bool = False


class TemplateVariablesResponse(BaseModel):
    """Template variable names extracted from content."""

    variables: list[str]  # Deduplicated list of {{variable_name}} placeholders
    dynamic_variables: list[str] = []  # Deduplicated list of <% dynamic_variable %> placeholders


# ==================== Workspace Visualization ====================


class WorkspaceNodeResponse(BaseModel):
    """A node in the workspace graph visualization."""

    id: int
    uuid: str
    name: str
    icon: str | None = None
    is_class: bool = False
    is_daily: bool = False
    is_monthly: bool = False
    is_yearly: bool = False
    class_ids: list[int] = []
    block_count: int = 0
    aliased_id: int | None = None


class WorkspaceLinkResponse(BaseModel):
    """A link between nodes in the workspace graph."""

    source: int
    target: int
    type: str
    weight: int | None = None


class WorkspaceDataResponse(BaseModel):
    """Full workspace data for graph visualization."""

    nodes: list[WorkspaceNodeResponse]
    links: list[WorkspaceLinkResponse]
    total: int | None = None
    page: int | None = None
    page_size: int | None = None
    has_next: bool | None = None
    has_prev: bool | None = None


class WorkspaceNodesResponse(BaseModel):
    """Workspace nodes without links."""

    nodes: list[WorkspaceNodeResponse]


class LinksRequest(BaseModel):
    """Request body for fetching links between nodes."""

    node_ids: list[int]
    scope: str = "between"
    cooccurrence: bool = False
    context_node_id: int | None = None


class LinksResponse(BaseModel):
    """Links between nodes."""

    links: list[WorkspaceLinkResponse]


class SearchResponse(BaseModel):
    """Search results."""

    nodes: list[NodeResponse]
