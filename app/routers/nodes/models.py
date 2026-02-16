"""Pydantic models for the Nodes API."""
from typing import Optional, List, Dict, Any
from pydantic import BaseModel


class NodeResponse(BaseModel):
    """Node response model."""
    id: int
    uuid: str
    name: str
    icon: Optional[str] = None
    color: Optional[str] = None
    parent_id: Optional[int] = None
    page_id: Optional[int] = None
    sequence: int = 0
    collapsed: bool = False
    active: bool = True
    is_page: bool = False  # Whether this node is a page
    is_class: bool = False  # Whether this node defines a class
    is_daily: bool = False  # Daily journal page
    is_monthly: bool = False  # Monthly journal page
    is_yearly: bool = False  # Yearly journal page
    create_date: str
    write_date: str
    open_date: Optional[str] = None  # When the page was last opened/viewed
    # Computed fields
    display_name: Optional[str] = None
    tags: List[int] = []  # Tag node IDs (descriptive linking with #)
    classes: List[int] = []  # Class node IDs (categorization with @)
    properties: Dict[str, Any] = {}
    # Linked references - classes_path (inherited classes from ancestors)
    classes_path: List[int] = []  # Inherited class node IDs from ancestors' classes properties
    # For tree responses
    children: Optional[List["NodeResponse"]] = None
    # Backlinks
    backlinks: Optional[List["BacklinkResponse"]] = None
    linked_references: Optional[List["LinkedReferenceResponse"]] = None
    backlink_count: int = 0  # Count of backlinks to this node
    # Comments
    comment_count: int = 0
    # Alias support
    aliased_id: Optional[int] = None  # If set, this node is an alias of the node with this ID
    aliases: List[int] = []  # IDs of nodes that are aliases of this node
    
    class Config:
        from_attributes = True


class BreadcrumbSegment(BaseModel):
    """A segment in the breadcrumb path."""
    node_id: Optional[int] = None  # None for property segments
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
    source_page_id: Optional[int] = None
    source_page_name: Optional[str] = None
    source_page_uuid: Optional[str] = None
    # Property info (for node-type property links)
    property_id: Optional[int] = None
    property_name: Optional[str] = None
    # Breadcrumb path with property provenance
    breadcrumb_path: List[BreadcrumbSegment] = []
    link_type: str  # "text" or "property"
    position: int


class LinkedReferenceResponse(BaseModel):
    """Linked reference with context."""
    source_node: NodeResponse
    source_page: Optional[NodeResponse] = None
    link_type: str
    context: str  # Text around the link
    breadcrumb_path: List[BreadcrumbSegment] = []  # Path from source to page
    # For property-type links
    property_id: Optional[int] = None
    property_name: Optional[str] = None
    # For text-property-context links: root block ID of the text property
    text_property_root_block_id: Optional[int] = None


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
    icon: Optional[str] = None
    color: Optional[str] = None
    parent_id: Optional[int] = None
    sequence: int = 0
    classes: List[int] = []  # Class node IDs - flags are computed from these
    properties: Dict[int, Any] = {}  # property_id -> value
    # For date nodes
    is_daily: bool = False
    daily_date: Optional[str] = None  # YYYY-MM-DD
    is_monthly: bool = False
    monthly_date: Optional[str] = None  # YYYY-MM
    is_yearly: bool = False
    yearly_date: Optional[str] = None  # YYYY


class NodeUpdateRequest(BaseModel):
    """Request to update a node."""
    name: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    parent_id: Optional[int] = None
    sequence: Optional[int] = None
    collapsed: Optional[bool] = None
    expected_version: Optional[int] = None  # For optimistic locking


class ClassRequest(BaseModel):
    """Request to add/remove a class."""
    class_node_id: int


class PropertyRequest(BaseModel):
    """Request to set a property value."""
    property_id: int
    value: Any


class MoveNodeRequest(BaseModel):
    """Request to move a node to a new parent and/or position."""
    parent_id: Optional[int] = None
    position: Optional[int] = None


class TagLinkRequest(BaseModel):
    """Request to add a tag link."""
    target_node_id: int


class NodeLinkResponse(BaseModel):
    """Response for a node link."""
    id: int
    uuid: str  # Unique identifier for this link instance
    source_node_id: int
    target_node_id: int
    is_tag: bool
    position: int
    name: Optional[str] = None  # Custom display text for the link


class UpdateLinkNameRequest(BaseModel):
    """Request to update a link's custom display name."""
    link_uuid: str
    name: Optional[str] = None  # None or empty string to clear custom name


class InlineClassResponse(BaseModel):
    """Inline class reference in content."""
    class_node_id: int
    class_node_name: str
    class_node_icon: Optional[str] = None
    position: int


class PropertyBacklinkResponse(BaseModel):
    """A page that references a target node via property."""
    source_page: NodeResponse
    property_id: int
    property_name: str


class CommentCreateRequest(BaseModel):
    """Request to create a comment on a node."""
    name: str = ""  # Initial comment content


class CommentResponse(BaseModel):
    """Response with comment node data."""
    id: int
    uuid: str
    name: str
    icon: str | None = None
    parent_id: int | None = None
    sequence: int = 0
    collapsed: bool = False
    create_date: str
    write_date: str
    children: list["CommentResponse"] | None = None
    
    class Config:
        from_attributes = True


class AliasRequest(BaseModel):
    """Request to add an alias."""
    alias_node_id: int


class CommentsResponse(BaseModel):
    """Response with list of comments."""
    comments: list[CommentResponse]
    comment_count: int


class DateFormatUpdateRequest(BaseModel):
    """Request to update date format for all date nodes."""
    new_format: str  # e.g., "YYYY/MM/DD", "DD-MM-YYYY", etc.


# ==================== Batch Operations ====================

class BatchNodeCreateItem(BaseModel):
    """A single node to create in a batch operation."""
    name: str = ""
    icon: Optional[str] = None
    color: Optional[str] = None
    parent_id: Optional[int] = None
    sequence: int = 0
    classes: List[int] = []
    properties: Dict[int, Any] = {}
    uuid: Optional[str] = None  # Optional: provide a UUID (e.g. from Logseq)


class BatchNodeCreateRequest(BaseModel):
    """Request to create multiple nodes in a single batch."""
    nodes: List[BatchNodeCreateItem]


class BatchNodeCreateResultItem(BaseModel):
    """Result for a single node creation in a batch."""
    index: int  # Index in the request array
    success: bool
    node: Optional[NodeResponse] = None
    error: Optional[str] = None


class BatchNodeCreateResponse(BaseModel):
    """Response for batch node creation."""
    results: List[BatchNodeCreateResultItem]
    created: int  # Count of successfully created nodes
    failed: int  # Count of failed nodes


class BatchNodeUpdateItem(BaseModel):
    """A single node update in a batch operation.
    
    Identifies the node by either id or uuid (at least one required).
    """
    id: Optional[int] = None
    uuid: Optional[str] = None
    name: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    parent_id: Optional[int] = None
    sequence: Optional[int] = None
    collapsed: Optional[bool] = None
    expected_version: Optional[int] = None


class BatchNodeUpdateRequest(BaseModel):
    """Request to update multiple nodes in a single batch."""
    nodes: List[BatchNodeUpdateItem]


class BatchNodeUpdateResultItem(BaseModel):
    """Result for a single node update in a batch."""
    index: int
    success: bool
    node: Optional[NodeResponse] = None
    error: Optional[str] = None


class BatchNodeUpdateResponse(BaseModel):
    """Response for batch node update."""
    results: List[BatchNodeUpdateResultItem]
    updated: int
    failed: int


class BatchNodeDeleteRequest(BaseModel):
    """Request to delete multiple nodes by UUID."""
    uuids: List[str]


class BatchNodeDeleteResultItem(BaseModel):
    """Result for a single node deletion in a batch."""
    index: int
    uuid: str
    success: bool
    error: Optional[str] = None


class BatchNodeDeleteResponse(BaseModel):
    """Response for batch node deletion."""
    results: List[BatchNodeDeleteResultItem]
    deleted: int
    failed: int


class BatchPermanentDeleteRequest(BaseModel):
    """Request to permanently delete multiple nodes from trash."""
    ids: List[int]


class BatchPermanentDeleteResultItem(BaseModel):
    """Result for a single permanent node deletion in a batch."""
    index: int
    id: int
    success: bool
    error: Optional[str] = None


class BatchPermanentDeleteResponse(BaseModel):
    """Response for batch permanent node deletion."""
    results: List[BatchPermanentDeleteResultItem]
    deleted: int
    failed: int
