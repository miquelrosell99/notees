"""Query AST domain entities.

Abstract Syntax Tree representation for queries.
This is the new canonical format that replaces QueryBlockTree.

Design principles:
- AST is serializable (JSON/JSONB)
- AST is validatable
- AST is the source of truth (UI and SQL are projections)
- AST is forward-compatible and extensible
- AST maintains some backward compatibility with QueryBlockTree for migration

Version: 1.0
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional, List, Any, Dict, Union, Literal
from datetime import datetime


# ==================== AST Node Types ====================

class ASTNodeType(str, Enum):
    """Types of nodes in the query AST."""
    QUERY = "query"
    SCOPE = "scope"
    GROUP = "group"
    CONDITION = "condition"
    NOT = "not"


# ==================== Scope Node ====================

class ScopeType(str, Enum):
    """Scope types define the universe of nodes to query."""
    ENTIRE_GRAPH = "entire_graph"      # All nodes in the graph
    PAGES = "pages"                    # All pages in the graph (is_page=true)
    CURRENT_PAGE = "current_page"      # Current page being viewed


@dataclass
class ScopeNode:
    """Scope node - defines the starting point for query execution."""
    type: Literal["scope"] = "scope"
    scope_type: ScopeType = ScopeType.ENTIRE_GRAPH
    # For parent_path filtering (nodes inside specific pages)
    include_descendants: Optional[bool] = None
    # For negated scope filters
    excluded_page_uuids: Optional[List[str]] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "type": self.type,
            "scope_type": self.scope_type.value,
        }
        if self.include_descendants is not None:
            result["include_descendants"] = self.include_descendants
        if self.excluded_page_uuids:
            result["excluded_page_uuids"] = self.excluded_page_uuids
        return result
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> ScopeNode:
        """Create from dictionary."""
        return ScopeNode(
            scope_type=ScopeType(data.get("scope_type", "entire_graph")),
            include_descendants=data.get("include_descendants"),
            excluded_page_uuids=data.get("excluded_page_uuids"),
        )


# ==================== Condition Node ====================

class ConditionType(str, Enum):
    """Types of conditions."""
    TYPE = "type"
    PROPERTY = "property"
    CONTENT = "content"
    REFERENCE = "reference"
    REFERENCE_PATH = "reference_path"
    PARENT_PATH = "parent_path"
    PARENT = "parent"
    FLAG = "flag"


class PropertyOperator(str, Enum):
    """Operators for property conditions."""
    EQUALS = "equals"
    NOT_EQUALS = "not_equals"
    GREATER_THAN = "greater_than"
    LESS_THAN = "less_than"
    GREATER_THAN_OR_EQUALS = "gte"
    LESS_THAN_OR_EQUALS = "lte"
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
    STARTS_WITH = "starts_with"
    ENDS_WITH = "ends_with"
    EQUALS = "equals"
    REGEX = "regex"
    FTS = "fts"  # Full-text search


class PropertyType(str, Enum):
    """Property types."""
    TEXT = "text"
    NUMBER = "number"
    DATE = "date"
    CHECKBOX = "checkbox"
    SELECT = "select"
    MULTI_SELECT = "multi_select"
    NODE = "node"


@dataclass
class BaseConditionNode:
    """Base for all condition nodes."""
    type: Literal["condition"] = "condition"
    condition_type: ConditionType = ConditionType.CONTENT
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "type": self.type,
            "condition_type": self.condition_type.value,
        }
        # Add all non-None fields from the dataclass
        for key, value in asdict(self).items():
            if key in ("type", "condition_type"):
                continue  # Already added above
            if value is None:
                continue  # Skip None values
            
            # Handle nested GroupNode
            if isinstance(value, GroupNode):
                result[key] = value.to_dict()
            # Handle enum values
            elif isinstance(value, Enum):
                result[key] = value.value
            else:
                result[key] = value
        
        return result


@dataclass
class TypeCondition(BaseConditionNode):
    """Type condition - filter by node type/class."""
    condition_type: Literal[ConditionType.TYPE] = ConditionType.TYPE
    # Use class prefix for consistency with frontend ClassCondition
    type_uuid: str = ""  # Alias for class_uuid
    type_id: Optional[int] = None  # Alias for class_id
    # Preferred names (align with frontend)
    class_uuid: Optional[str] = None
    class_id: Optional[int] = None
    
    def __post_init__(self):
        """Ensure backward compatibility by aliasing type_uuid to class_uuid."""
        if self.class_uuid and not self.type_uuid:
            self.type_uuid = self.class_uuid
        elif self.type_uuid and not self.class_uuid:
            self.class_uuid = self.type_uuid
        
        if self.class_id and not self.type_id:
            self.type_id = self.class_id
        elif self.type_id and not self.class_id:
            self.class_id = self.type_id


@dataclass
class PropertyCondition(BaseConditionNode):
    """Property condition - filter by property value."""
    condition_type: Literal[ConditionType.PROPERTY] = ConditionType.PROPERTY
    property_name: str = ""
    property_id: Optional[int] = None
    property_type: PropertyType = PropertyType.TEXT
    operator: PropertyOperator = PropertyOperator.EQUALS
    value: Optional[Any] = None


@dataclass
class ContentCondition(BaseConditionNode):
    """Content condition - filter by content/name."""
    condition_type: Literal[ConditionType.CONTENT] = ConditionType.CONTENT
    operator: ContentOperator = ContentOperator.CONTAINS
    value: str = ""
    case_sensitive: Optional[bool] = None


@dataclass
class ReferenceCondition(BaseConditionNode):
    """Reference condition - filter by references."""
    condition_type: Literal[ConditionType.REFERENCE] = ConditionType.REFERENCE
    target_uuid: str = ""
    target_id: Optional[int] = None
    # Optional nested group for filtering the referencing nodes
    nested_group: Optional["GroupNode"] = None


@dataclass
class ReferencePathCondition(BaseConditionNode):
    """Reference path condition - filter by nodes that reference nodes matching criteria."""
    condition_type: Literal[ConditionType.REFERENCE_PATH] = ConditionType.REFERENCE_PATH
    nested_group: Optional["GroupNode"] = None


@dataclass
class ParentPathCondition(BaseConditionNode):
    """Parent path condition - filter by nodes with ancestors matching criteria."""
    condition_type: Literal[ConditionType.PARENT_PATH] = ConditionType.PARENT_PATH
    nested_group: Optional["GroupNode"] = None
    max_depth: Optional[int] = None


@dataclass
class ParentCondition(BaseConditionNode):
    """Parent condition - filter by direct parent node matching criteria."""
    condition_type: Literal[ConditionType.PARENT] = ConditionType.PARENT
    # Static mode: specific parent
    parent_uuid: Optional[str] = None
    parent_id: Optional[int] = None
    # Dynamic mode: parent matching criteria
    nested_group: Optional["GroupNode"] = None
    operator: Optional[str] = None  # 'has_parent' | 'has_no_parent'


@dataclass
class FlagCondition(BaseConditionNode):
    """Flag condition - filter by boolean flags (is_page, is_day, etc)."""
    condition_type: Literal[ConditionType.FLAG] = ConditionType.FLAG
    flag_name: str = ""  # e.g., "is_page", "is_day", "is_favorite"
    value: bool = True  # True to match, False to exclude


# Union type for all conditions
ConditionNode = Union[
    TypeCondition,
    PropertyCondition,
    ContentCondition,
    ReferenceCondition,
    ReferencePathCondition,
    ParentPathCondition,
    ParentCondition,
    FlagCondition,
]


# ==================== Group Node ====================

class LogicType(str, Enum):
    """Logic type for how conditions in a group combine."""
    AND = "AND"
    OR = "OR"


@dataclass
class GroupNode:
    """Group node - contains conditions and nested groups."""
    type: Literal["group"] = "group"
    logic: LogicType = LogicType.AND
    children: List[Union[ConditionNode, "GroupNode", "NotNode"]] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "type": self.type,
            "logic": self.logic.value,
            "children": [
                child.to_dict() if hasattr(child, 'to_dict') else child
                for child in self.children
            ],
        }
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> GroupNode:
        """Create from dictionary."""
        children = []
        for child_data in data.get("children", []):
            if child_data.get("type") == "group":
                children.append(GroupNode.from_dict(child_data))
            elif child_data.get("type") == "not":
                children.append(NotNode.from_dict(child_data))
            elif child_data.get("type") == "condition":
                children.append(condition_from_dict(child_data))
        
        return GroupNode(
            logic=LogicType(data.get("logic", "AND")),
            children=children,
        )


# ==================== Not Node ====================

@dataclass
class NotNode:
    """Not node - negates a condition or group."""
    type: Literal["not"] = "not"
    child: Union[ConditionNode, GroupNode] = field(default_factory=lambda: ContentCondition())
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "type": self.type,
            "child": self.child.to_dict() if hasattr(self.child, 'to_dict') else self.child,
        }
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> NotNode:
        """Create from dictionary."""
        child_data = data.get("child", {})
        if child_data.get("type") == "group":
            child = GroupNode.from_dict(child_data)
        else:
            child = condition_from_dict(child_data)
        
        return NotNode(child=child)


# ==================== Query AST Root ====================

@dataclass
class QueryAST:
    """Query AST root - the complete query representation."""
    type: Literal["query"] = "query"
    version: str = "1.0"  # For future compatibility
    scope: ScopeNode = field(default_factory=ScopeNode)
    root_group: GroupNode = field(default_factory=GroupNode)
    
    # Metadata
    id: Optional[str] = None  # Stable identifier for query identity
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    description: Optional[str] = None
    
    # System queries are read-only (e.g., linked references, child pages)
    is_system: Optional[bool] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "type": self.type,
            "version": self.version,
            "scope": self.scope.to_dict(),
            "root_group": self.root_group.to_dict(),
        }
        if self.id:
            result["id"] = self.id
        if self.created_at:
            result["created_at"] = self.created_at
        if self.updated_at:
            result["updated_at"] = self.updated_at
        if self.description:
            result["description"] = self.description
        if self.is_system:
            result["is_system"] = self.is_system
        return result
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> QueryAST:
        """Create from dictionary."""
        return QueryAST(
            version=data.get("version", "1.0"),
            scope=ScopeNode.from_dict(data.get("scope", {})),
            root_group=GroupNode.from_dict(data.get("root_group", {})),
            id=data.get("id"),
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
            description=data.get("description"),
            is_system=data.get("is_system"),
        )


# ==================== Helper Functions ====================

def condition_from_dict(data: Dict[str, Any]) -> ConditionNode:
    """Create a ConditionNode from dictionary based on condition_type."""
    condition_type = ConditionType(data.get("condition_type", "content"))
    
    if condition_type == ConditionType.TYPE:
        return TypeCondition(
            type_uuid=data.get("type_uuid", ""),
            type_id=data.get("type_id"),
        )
    elif condition_type == ConditionType.PROPERTY:
        return PropertyCondition(
            property_name=data.get("property_name", ""),
            property_id=data.get("property_id"),
            property_type=PropertyType(data.get("property_type", "text")),
            operator=PropertyOperator(data.get("operator", "equals")),
            value=data.get("value"),
        )
    elif condition_type == ConditionType.CONTENT:
        return ContentCondition(
            operator=ContentOperator(data.get("operator", "contains")),
            value=data.get("value", ""),
            case_sensitive=data.get("case_sensitive"),
        )
    elif condition_type == ConditionType.REFERENCE:
        nested_group = None
        if "nested_group" in data and data["nested_group"]:
            nested_group = GroupNode.from_dict(data["nested_group"])
        return ReferenceCondition(
            target_uuid=data.get("target_uuid", ""),
            target_id=data.get("target_id"),
            nested_group=nested_group,
        )
    elif condition_type == ConditionType.REFERENCE_PATH:
        nested_group = None
        if "nested_group" in data and data["nested_group"]:
            nested_group = GroupNode.from_dict(data["nested_group"])
        return ReferencePathCondition(nested_group=nested_group)
    elif condition_type == ConditionType.PARENT_PATH:
        nested_group = None
        if "nested_group" in data and data["nested_group"]:
            nested_group = GroupNode.from_dict(data["nested_group"])
        return ParentPathCondition(
            nested_group=nested_group,
            max_depth=data.get("max_depth"),
        )
    elif condition_type == ConditionType.PARENT:
        nested_group = None
        if "nested_group" in data and data["nested_group"]:
            nested_group = GroupNode.from_dict(data["nested_group"])
        return ParentCondition(
            parent_uuid=data.get("parent_uuid"),
            parent_id=data.get("parent_id"),
            operator=data.get("operator", "has_parent"),
            nested_group=nested_group,
        )
    elif condition_type == ConditionType.FLAG:
        return FlagCondition(
            flag_name=data.get("flag_name", ""),
            value=data.get("value", True),
        )
    else:
        # Default to content condition
        return ContentCondition()


def create_default_query_ast() -> QueryAST:
    """Create a default empty QueryAST."""
    return QueryAST(
        scope=ScopeNode(),
        root_group=GroupNode(),
        created_at=datetime.utcnow().isoformat(),
    )
