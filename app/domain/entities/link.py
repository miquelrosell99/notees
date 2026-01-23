"""Node link entity.

Stores parsed links from node content for efficient backlink queries.
Links use the unified [[nodeId]] format for both pages and blocks.

Link sources can be:
1. Text links: Direct [[id]] syntax in a block's name field
   - source_id = the block T containing the link
   
2. Node-type property links: References via node-type properties
   - Stored via property_value_relation table, not node_link
   
The system property `types` is excluded from backlinks entirely.

Inline types use {{typeId}} format for type references in block content.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

# Import from shared utility for consistency
from ...utils import utc_now


@dataclass
class NodeLink:
    """Represents a link from one node to another.
    
    All links use the unified [[nodeId]] format. The target node's
    is_page flag determines whether it's a page or block link.
    
    If is_tag is True, the link is a tag reference (displayed with #)
    rather than a regular [[link]].
    
    Schema fields:
    - source_id: Node containing the link
    - target_id: Referenced node
    - position: Character position in the source node's content
    - is_tag: Whether this is a tag link
    - create_date: When the link was created
    - create_uid: User who created the link
    """
    id: Optional[int] = None
    source_id: int = 0  # Node containing the link
    target_id: int = 0  # Referenced node
    position: int = 0  # Character position in the source node's content
    is_tag: bool = False  # True if this is a tag reference (displayed with #)
    create_date: datetime = field(default_factory=utc_now)
    create_uid: Optional[int] = None
    
    # Legacy aliases for backward compatibility
    @property
    def source_node_id(self) -> int:
        return self.source_id
    
    @property
    def target_node_id(self) -> int:
        return self.target_id
    
    @property
    def created_at(self) -> datetime:
        return self.create_date


@dataclass
class InlineType:
    """Represents an inline type reference in block content.
    
    Uses {{typeId}} format in content. Similar to NodeLink but
    specifically for type references that appear inline in text.
    
    Schema fields (type_inline table):
    - node_id: Block containing the {{typeId}} reference
    - type_id: The type node being referenced
    - position: Character position in content
    - create_date: When the reference was created
    - create_uid: User who created it
    """
    id: Optional[int] = None
    node_id: int = 0  # Block containing the inline type reference
    type_id: int = 0  # Referenced type node
    position: int = 0  # Character position in content
    create_date: datetime = field(default_factory=utc_now)
    create_uid: Optional[int] = None
    
    # Legacy aliases for backward compatibility
    @property
    def source_node_id(self) -> int:
        return self.node_id
    
    @property
    def type_node_id(self) -> int:
        return self.type_id
    
    @property
    def created_at(self) -> datetime:
        return self.create_date


@dataclass
class BacklinkInfo:
    """Extended backlink information with provenance for display.
    
    Contains all information needed to render a backlink with proper
    breadcrumbs showing property provenance.
    """
    link: NodeLink
    
    # Source information
    source_node_id: int  # The explicit linker (T for text, B for property)
    source_node_name: str
    source_node_uuid: str
    source_is_page: bool
    
    # Page context (for blocks)
    source_page_id: Optional[int] = None
    source_page_name: Optional[str] = None
    source_page_uuid: Optional[str] = None
    
    # Property provenance (for property links)
    property_id: Optional[int] = None
    property_name: Optional[str] = None
    
    # Breadcrumb path from source to page ancestor
    # Format: [(node_id, name, is_property_segment), ...]
    # Property names are included as breadcrumb segments
    breadcrumb_path: list = field(default_factory=list)
