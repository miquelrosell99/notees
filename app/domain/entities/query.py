"""Query domain entities.

Defines the structure for query block trees used by query nodes.
Query block trees are stored as JSON:
- For NodeViews: directly in the query_json column of node_view table
- For Query blocks: in the _query_ast property of query nodes
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, List, Any, Dict, Union


class QueryBlockType(str, Enum):
    """Types of blocks that can appear in a query block tree."""
    # Containers
    AND_CONTAINER = "AND_CONTAINER"
    OR_CONTAINER = "OR_CONTAINER"
    NOT_CONTAINER = "NOT_CONTAINER"
    
    # Leaf blocks (conditions)
    CLASS = "CLASS"
    PROPERTY = "PROPERTY"
    CONTENT = "CONTENT"
    REFERENCE = "REFERENCE"
    REFERENCE_PATH = "REFERENCE_PATH"
    PARENT = "PARENT"
    PARENT_PATH = "PARENT_PATH"
    CHILD = "CHILD"
    CHILD_PATH = "CHILD_PATH"
    CLASS_PATH = "CLASS_PATH"
    UUID = "UUID"


class PropertyOperator(str, Enum):
    """Operators for property conditions."""
    EQUALS = "="
    NOT_EQUALS = "!="
    GREATER_THAN = ">"
    GREATER_THAN_OR_EQUALS = ">="
    LESS_THAN = "<"
    LESS_THAN_OR_EQUALS = "<="
    CONTAINS = "contains"
    STARTS_WITH = "starts_with"
    ENDS_WITH = "ends_with"
    IS_EMPTY = "is_empty"
    IS_NOT_EMPTY = "is_not_empty"
    IN = "in"
    NOT_IN = "not_in"


class ContentOperator(str, Enum):
    """Operators for content/text search conditions."""
    CONTAINS = "contains"
    EQUALS = "="
    STARTS_WITH = "starts_with"
    ENDS_WITH = "ends_with"
    MATCHES_REGEX = "matches_regex"
    FTS = "fts"  # Full-text search


@dataclass
class QueryBlock:
    """Base class for all query blocks.
    
    This is a simplified representation that can be serialized to/from JSON.
    The actual query block tree uses dicts for JSON compatibility.
    """
    type: QueryBlockType
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {"type": self.type.value}
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "QueryBlock":
        """Create a QueryBlock from dictionary."""
        block_type = QueryBlockType(data.get("type", "AND_CONTAINER"))
        
        if block_type in (QueryBlockType.AND_CONTAINER, QueryBlockType.OR_CONTAINER):
            return ContainerBlock.from_dict(data)
        elif block_type == QueryBlockType.NOT_CONTAINER:
            return NotBlock.from_dict(data)
        elif block_type == QueryBlockType.CLASS:
            return ClassBlock.from_dict(data)
        elif block_type == QueryBlockType.PROPERTY:
            return PropertyBlock.from_dict(data)
        elif block_type == QueryBlockType.CONTENT:
            return ContentBlock.from_dict(data)
        elif block_type == QueryBlockType.REFERENCE:
            return ReferenceBlock.from_dict(data)
        elif block_type == QueryBlockType.REFERENCE_PATH:
            return ReferencePathBlock.from_dict(data)
        elif block_type == QueryBlockType.PARENT:
            return ParentBlock.from_dict(data)
        elif block_type == QueryBlockType.PARENT_PATH:
            return ParentPathBlock.from_dict(data)
        elif block_type == QueryBlockType.CHILD:
            return ChildBlock.from_dict(data)
        elif block_type == QueryBlockType.CHILD_PATH:
            return ChildPathBlock.from_dict(data)
        elif block_type == QueryBlockType.CLASS_PATH:
            return ClassPathBlock.from_dict(data)
        elif block_type == QueryBlockType.UUID:
            return UuidBlock.from_dict(data)
        else:
            # Default to empty AND container
            return ContainerBlock(type=QueryBlockType.AND_CONTAINER, blocks=[])


@dataclass
class ContainerBlock(QueryBlock):
    """AND/OR container block with nested blocks."""
    blocks: List[QueryBlock] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.type.value,
            "blocks": [b.to_dict() for b in self.blocks]
        }
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "ContainerBlock":
        block_type = QueryBlockType(data.get("type", "AND_CONTAINER"))
        blocks = [QueryBlock.from_dict(b) for b in data.get("blocks", [])]
        return ContainerBlock(type=block_type, blocks=blocks)


@dataclass
class NotBlock(QueryBlock):
    """NOT container block that negates a single nested block."""
    type: QueryBlockType = field(default=QueryBlockType.NOT_CONTAINER)
    block: Optional[QueryBlock] = None
    
    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {"type": self.type.value}
        if self.block:
            result["block"] = self.block.to_dict()
        return result
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "NotBlock":
        block_data = data.get("block")
        block = QueryBlock.from_dict(block_data) if block_data else None
        return NotBlock(block=block)


@dataclass
class ClassBlock(QueryBlock):
    """Filter by node class."""
    type: QueryBlockType = field(default=QueryBlockType.CLASS)
    value: str = ""  # Type name or ID
    type_id: Optional[int] = None  # Resolved type node ID
    
    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {"type": self.type.value, "value": self.value}
        if self.type_id is not None:
            result["type_id"] = self.type_id
        return result
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "ClassBlock":
        return ClassBlock(
            value=data.get("value", ""),
            type_id=data.get("type_id")
        )


@dataclass
class PropertyBlock(QueryBlock):
    """Filter by property value."""
    type: QueryBlockType = field(default=QueryBlockType.PROPERTY)
    property_name: str = ""
    property_id: Optional[int] = None  # Resolved property ID
    property_type: str = "text"  # text, number, boolean, selection, node, date
    operator: str = "="
    value: Any = None
    
    def to_dict(self) -> Dict[str, Any]:
        result = {
            "type": self.type.value,
            "property_name": self.property_name,
            "property_type": self.property_type,
            "operator": self.operator,
            "value": self.value,
        }
        if self.property_id is not None:
            result["property_id"] = self.property_id
        return result
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "PropertyBlock":
        return PropertyBlock(
            property_name=data.get("property_name", ""),
            property_id=data.get("property_id"),
            property_type=data.get("property_type", "text"),
            operator=data.get("operator", "="),
            value=data.get("value"),
        )


@dataclass
class ContentBlock(QueryBlock):
    """Filter by content/name text."""
    type: QueryBlockType = field(default=QueryBlockType.CONTENT)
    operator: str = "contains"
    value: str = ""
    case_sensitive: bool = False
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.type.value,
            "operator": self.operator,
            "value": self.value,
            "case_sensitive": self.case_sensitive,
        }
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "ContentBlock":
        return ContentBlock(
            operator=data.get("operator", "contains"),
            value=data.get("value", ""),
            case_sensitive=data.get("case_sensitive", False),
        )


@dataclass
class ReferenceBlock(QueryBlock):
    """Filter nodes that reference a specific node."""
    type: QueryBlockType = field(default=QueryBlockType.REFERENCE)
    target_uuid: str = ""  # UUID of target node or placeholder like {current_node_uuid}
    target_id: Optional[int] = None  # Resolved target node ID
    # Optional nested filters for the referencing nodes
    blocks: List[QueryBlock] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "type": self.type.value,
            "target_uuid": self.target_uuid,
        }
        if self.target_id is not None:
            result["target_id"] = self.target_id
        if self.blocks:
            result["blocks"] = [b.to_dict() for b in self.blocks]
        return result
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "ReferenceBlock":
        blocks = [QueryBlock.from_dict(b) for b in data.get("blocks", [])]
        return ReferenceBlock(
            target_uuid=data.get("target_uuid", ""),
            target_id=data.get("target_id"),
            blocks=blocks,
        )


@dataclass
class ReferencePathBlock(QueryBlock):
    """Filter nodes that have a reference path through specific node types.
    
    This finds nodes that reference nodes matching the nested filter criteria.
    For example: Find all tasks that reference any meeting.
    """
    type: QueryBlockType = field(default=QueryBlockType.REFERENCE_PATH)
    # Nested filters for what the references should match
    blocks: List[QueryBlock] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.type.value,
            "blocks": [b.to_dict() for b in self.blocks],
        }
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "ReferencePathBlock":
        blocks = [QueryBlock.from_dict(b) for b in data.get("blocks", [])]
        return ReferencePathBlock(blocks=blocks)


@dataclass
class ParentBlock(QueryBlock):
    """Filter by direct parent nodes.
    
    This finds nodes whose parent matches the nested filter criteria.
    For example: Find all blocks whose parent is a specific page.
    """
    type: QueryBlockType = field(default=QueryBlockType.PARENT)
    # Nested filters for what the parent should match
    blocks: List[QueryBlock] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.type.value,
            "blocks": [b.to_dict() for b in self.blocks],
        }
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "ParentBlock":
        blocks = [QueryBlock.from_dict(b) for b in data.get("blocks", [])]
        return ParentBlock(blocks=blocks)


@dataclass
class ParentPathBlock(QueryBlock):
    """Filter by ancestor nodes (parent hierarchy).
    
    This finds nodes that have ancestors matching the nested filter criteria.
    For example: Find all blocks that are descendants of a specific page.
    """
    type: QueryBlockType = field(default=QueryBlockType.PARENT_PATH)
    # Nested filters for what the ancestors should match
    blocks: List[QueryBlock] = field(default_factory=list)
    max_depth: Optional[int] = None  # Optional depth limit
    
    def to_dict(self) -> Dict[str, Any]:
        result = {
            "type": self.type.value,
            "blocks": [b.to_dict() for b in self.blocks],
        }
        if self.max_depth is not None:
            result["max_depth"] = self.max_depth
        return result
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "ParentPathBlock":
        blocks = [QueryBlock.from_dict(b) for b in data.get("blocks", [])]
        max_depth = data.get("max_depth")
        return ParentPathBlock(blocks=blocks, max_depth=max_depth)


@dataclass
class ChildBlock(QueryBlock):
    """Filter by direct children nodes.
    
    This finds nodes that have children matching the nested filter criteria.
    For example: Find all pages that have TODO blocks as direct children.
    """
    type: QueryBlockType = field(default=QueryBlockType.CHILD)
    # Nested filters for what the children should match
    blocks: List[QueryBlock] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.type.value,
            "blocks": [b.to_dict() for b in self.blocks],
        }
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "ChildBlock":
        blocks = [QueryBlock.from_dict(b) for b in data.get("blocks", [])]
        return ChildBlock(blocks=blocks)


@dataclass
class ChildPathBlock(QueryBlock):
    """Filter by descendant nodes (child hierarchy).
    
    This finds nodes that have descendants matching the nested filter criteria.
    For example: Find all pages that contain TODO blocks anywhere in their hierarchy.
    """
    type: QueryBlockType = field(default=QueryBlockType.CHILD_PATH)
    # Nested filters for what the descendants should match
    blocks: List[QueryBlock] = field(default_factory=list)
    max_depth: Optional[int] = None  # Optional depth limit
    
    def to_dict(self) -> Dict[str, Any]:
        result = {
            "type": self.type.value,
            "blocks": [b.to_dict() for b in self.blocks],
        }
        if self.max_depth is not None:
            result["max_depth"] = self.max_depth
        return result
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "ChildPathBlock":
        blocks = [QueryBlock.from_dict(b) for b in data.get("blocks", [])]
        max_depth = data.get("max_depth")
        return ChildPathBlock(blocks=blocks, max_depth=max_depth)


@dataclass
class UuidBlock(QueryBlock):
    """Filter by exact UUID match."""
    type: QueryBlockType = field(default=QueryBlockType.UUID)
    value: str = ""  # UUID or placeholder like {current_node_uuid}
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.type.value,
            "value": self.value,
        }
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "UuidBlock":
        return UuidBlock(value=data.get("value", ""))


@dataclass
class ClassPathBlock(QueryBlock):
    """Filter nodes by inherited classes from ancestors.
    
    This finds nodes that have a specific class assigned to them
    or inherited from any ancestor in their hierarchy (via classes_path).
    For example: Find all nodes that have the "Meeting" class,
    either directly or inherited from a parent page.
    """
    type: QueryBlockType = field(default=QueryBlockType.CLASS_PATH)
    value: str = ""  # UUID of the class node
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.type.value,
            "value": self.value,
        }
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "ClassPathBlock":
        return ClassPathBlock(value=data.get("value", ""))


@dataclass
class QueryAST:
    """Root of a query block tree.
    
    Always starts with a container block (AND or OR).
    """
    root: ContainerBlock = field(default_factory=lambda: ContainerBlock(
        type=QueryBlockType.AND_CONTAINER,
        blocks=[]
    ))
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return self.root.to_dict()
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "QueryAST":
        """Create a QueryAST from dictionary."""
        if not data:
            return QueryAST()
        root = ContainerBlock.from_dict(data)
        return QueryAST(root=root)
    
    def is_empty(self) -> bool:
        """Check if the query has no conditions."""
        return len(self.root.blocks) == 0


@dataclass
class NodeView:
    """Domain entity representing a NodeView.
    
    NodeViews define dynamic query tabs for displaying node collections.
    The query_json stores the block tree directly (no separate query node needed).
    """
    id: Optional[int] = None
    uuid: str = ""
    node_id: int = 0  # The node this view belongs to
    name: str = ""  # Display name for the tab
    query_json: Optional[Dict[str, Any]] = None  # The query block tree JSON
    view_type: str = ""  # e.g., child_pages, classed_nodes, linked_references
    order_index: int = 0  # Tab order within view_type
    is_default: bool = False  # Whether this is the default tab for the view_type
    active: bool = True
    shown_properties: List[Dict[str, Any]] = field(default_factory=list)  # [{uuid: str, sequence: int}] for table columns
    group_by: Optional[str] = None  # Group by field for card view (property uuid or 'page'/'type')
    create_date: str = ""
    write_date: str = ""
    create_uid: Optional[int] = None
    write_uid: Optional[int] = None


# Mapping of runtime parameter placeholders
QUERY_PLACEHOLDERS = {
    "{current_node_uuid}": "The UUID of the current node being viewed",
    "{current_node_id}": "The ID of the current node being viewed",
    "{current_user_id}": "The ID of the current user",
    "{today}": "Today's date",
    "{this_week}": "Start of current week",
    "{this_month}": "Start of current month",
    "{this_year}": "Start of current year",
}
