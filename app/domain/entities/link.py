"""Node link entity.

Stores parsed links from node content for efficient backlink queries.
Links use the unified [[nodeId]] format for both pages and blocks.

Link sources can be:
1. Text links: Direct [[id]] syntax in a block's name field
   - source_node_id = the block T containing the link
   - property_id = NULL (direct text link)
   
2. Node-type property links: References via node-type properties
   - source_node_id = the property owner B
   - property_id = the property through which the link is made
   
The system property `types` is excluded from backlinks entirely.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional


def utc_now() -> datetime:
    """Get current UTC time as timezone-aware datetime."""
    return datetime.now(timezone.utc)


@dataclass
class NodeLink:
    """Represents a link from one node to another.
    
    All links use the unified [[nodeId]] format. The target node's
    is_page flag determines whether it's a page or block link.
    
    For text links: source_node_id is block T, property_id is None
    For property links: source_node_id is property owner B, property_id is set
    """
    id: Optional[int] = None
    source_node_id: int = 0  # Node containing the link (T for text, B for property)
    target_node_id: int = 0  # Referenced node (X)
    position: int = 0  # Character position in name (for text links only)
    property_id: Optional[int] = None  # Property ID if this is a property link
    created_at: datetime = field(default_factory=utc_now)


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
