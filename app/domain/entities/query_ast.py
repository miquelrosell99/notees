"""Query AST domain entities.

Abstract Syntax Tree representation for queries.
This is the new canonical format that replaces QueryAST.

Design principles:
- AST is serializable (JSON/JSONB)
- AST is validatable
- AST is the source of truth (UI and SQL are projections)
- AST is forward-compatible and extensible
- AST maintains some backward compatibility with QueryAST for migration

Version: 1.0
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Literal, Union

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

    ENTIRE_WORKSPACE = "entire_workspace"  # All nodes in the workspace
    PAGES = "pages"  # All pages in the workspace (is_page=true)
    CURRENT_PAGE = "current_page"  # Current page being viewed


@dataclass
class ScopeNode:
    """Scope node - defines the starting point for query execution."""

    type: Literal["scope"] = "scope"
    scope_type: ScopeType = ScopeType.ENTIRE_WORKSPACE
    # For parent_path filtering (nodes inside specific pages)
    include_descendants: bool | None = None
    # For negated scope filters
    excluded_page_uuids: list[str] | None = None

    def to_dict(self) -> dict[str, Any]:
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
    def from_dict(data: dict[str, Any]) -> ScopeNode:
        """Create from dictionary."""
        scope_type_value = data.get("scope_type", "entire_workspace")

        # Handle legacy 'all' value (backwards compatibility)
        if scope_type_value == "all":
            scope_type_value = "entire_workspace"

        return ScopeNode(
            scope_type=ScopeType(scope_type_value),
            include_descendants=data.get("include_descendants"),
            excluded_page_uuids=data.get("excluded_page_uuids"),
        )


# ==================== Condition Node ====================


class ConditionType(str, Enum):
    """Types of conditions."""

    CLASS = "class"
    EXTENDS = "extends"
    PROPERTY = "property"
    CONTENT = "content"
    STYLE = "style"
    REFERENCE = "reference"
    REFERENCE_PATH = "reference_path"
    PARENT_PATH = "parent_path"
    PARENT = "parent"
    CHILD = "child"
    CHILD_PATH = "child_path"
    FLAG = "flag"
    PAGE = "page"


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
    SELECTION = "selection"


@dataclass
class BaseConditionNode:
    """Base for all condition nodes."""

    type: Literal["condition"] = "condition"
    condition_type: ConditionType = ConditionType.CONTENT

    def to_dict(self) -> dict[str, Any]:
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
class ClassCondition(BaseConditionNode):
    """Class condition - filter by node class."""

    condition_type: Literal[ConditionType.CLASS] = ConditionType.CLASS
    class_uuid: str = ""
    class_id: int | None = None
    operator: str | None = None  # 'contains' | 'does_not_contain' | 'is' | 'is_not' | 'defined' | 'not_defined'


@dataclass
class ExtendsCondition(BaseConditionNode):
    """Extends condition - filter by classes that extend a given class."""

    condition_type: Literal[ConditionType.EXTENDS] = ConditionType.EXTENDS
    extends_class_uuid: str = ""  # UUID of the class being extended
    extends_class_id: int | None = None


@dataclass
class PropertyCondition(BaseConditionNode):
    """Property condition - filter by property value."""

    condition_type: Literal[ConditionType.PROPERTY] = ConditionType.PROPERTY
    property_name: str = ""
    property_uuid: str | None = None
    property_id: int | None = None
    property_type: PropertyType = PropertyType.TEXT
    operator: PropertyOperator = PropertyOperator.EQUALS
    value: Any | None = None


@dataclass
class ContentCondition(BaseConditionNode):
    """Content condition - filter by content/name."""

    condition_type: Literal[ConditionType.CONTENT] = ConditionType.CONTENT
    operator: ContentOperator = ContentOperator.CONTAINS
    value: str = ""
    case_sensitive: bool | None = None


class StyleType(str, Enum):
    """Style types for formatting filters."""

    BOLD = "bold"
    ITALIC = "italic"
    UNDERLINE = "underline"
    STRIKETHROUGH = "strikethrough"
    BROKEN_LINK = "broken_link"


class StyleOperator(str, Enum):
    """Operators for style/formatting conditions."""

    IS = "is"
    IS_NOT = "is_not"
    CONTAINS = "contains"
    DOES_NOT_CONTAIN = "does_not_contain"


@dataclass
class StyleCondition(BaseConditionNode):
    """Style condition - filter by text formatting (bold, italic, underline, strikethrough)."""

    condition_type: Literal[ConditionType.STYLE] = ConditionType.STYLE
    style_type: StyleType = StyleType.BOLD
    operator: StyleOperator = StyleOperator.CONTAINS


@dataclass
class ReferenceCondition(BaseConditionNode):
    """Reference condition - filter by references."""

    condition_type: Literal[ConditionType.REFERENCE] = ConditionType.REFERENCE
    target_uuid: str = ""
    target_id: int | None = None
    # Optional nested group for filtering the referencing nodes
    nested_group: GroupNode | None = None


@dataclass
class ReferencePathCondition(BaseConditionNode):
    """Reference path condition - filter by nodes that reference nodes matching criteria.

    A node N matches reference_path to target T if:
    - N or any ancestor of N has a reference (link) to T
    - OR T is an ancestor of N (N is inside T's hierarchy)
    """

    condition_type: Literal[ConditionType.REFERENCE_PATH] = ConditionType.REFERENCE_PATH
    # Static mode: specific target node(s) being referenced
    target_uuids: list[str] | None = None
    target_ids: list[int] | None = None
    # Dynamic mode: target nodes matching criteria
    nested_group: GroupNode | None = None


@dataclass
class ParentPathCondition(BaseConditionNode):
    """Parent path condition - filter by nodes with ancestors matching criteria."""

    condition_type: Literal[ConditionType.PARENT_PATH] = ConditionType.PARENT_PATH
    nested_group: GroupNode | None = None
    max_depth: int | None = None
    operator: str | None = None  # 'has_ancestor' | 'has_no_ancestor' | 'is_descendant_of' | 'is_not_descendant_of'


@dataclass
class ParentCondition(BaseConditionNode):
    """Parent condition - filter by direct parent node matching criteria."""

    condition_type: Literal[ConditionType.PARENT] = ConditionType.PARENT
    # Static mode: specific parent(s)
    parent_uuid: str | None = None  # Legacy: single parent
    parent_uuids: list[str] | None = None  # Multiple parents
    parent_id: int | None = None
    parent_ids: list[int] | None = None
    # Dynamic mode: parent matching criteria
    nested_group: GroupNode | None = None
    operator: str | None = None  # 'has_parent' | 'not_has_parent' | 'has_no_parent' | 'has_any_parent'


@dataclass
class FlagCondition(BaseConditionNode):
    """Flag condition - filter by boolean flags (is_page, is_day, etc)."""

    condition_type: Literal[ConditionType.FLAG] = ConditionType.FLAG
    flag_name: str = ""  # e.g., "is_page", "is_day", "is_favorite"
    value: bool = True  # True to match, False to exclude


@dataclass
class PageCondition(BaseConditionNode):
    """Page condition - filter by containing page (via page_id)."""

    condition_type: Literal[ConditionType.PAGE] = ConditionType.PAGE
    # Static mode: specific page(s)
    page_uuid: str | None = None
    page_uuids: list[str] | None = None
    page_id: int | None = None
    page_ids: list[int] | None = None
    # Dynamic mode: page matching criteria
    nested_group: GroupNode | None = None
    operator: str | None = None  # 'is_page' | 'is_not_page' | 'has_no_page' | 'has_any_page'


@dataclass
class ChildCondition(BaseConditionNode):
    """Child condition - filter by direct child nodes matching criteria."""

    condition_type: Literal[ConditionType.CHILD] = ConditionType.CHILD
    # Static mode: specific child(ren)
    child_uuids: list[str] | None = None
    child_ids: list[int] | None = None
    # Dynamic mode: children matching criteria
    nested_group: GroupNode | None = None
    operator: str | None = None  # 'has_child' | 'not_has_child' | 'has_no_child' | 'has_any_child'


@dataclass
class ChildPathCondition(BaseConditionNode):
    """Child path condition - filter by nodes with descendants matching criteria."""

    condition_type: Literal[ConditionType.CHILD_PATH] = ConditionType.CHILD_PATH
    nested_group: GroupNode | None = None
    max_depth: int | None = None
    operator: str | None = None  # 'has_descendant' | 'not_has_descendant' | 'has_no_descendant' | 'has_any_descendant'


# Union type for all conditions
ConditionNode = Union[
    ClassCondition,
    ExtendsCondition,
    PropertyCondition,
    ContentCondition,
    StyleCondition,
    ReferenceCondition,
    ReferencePathCondition,
    ParentPathCondition,
    ParentCondition,
    ChildCondition,
    ChildPathCondition,
    FlagCondition,
    PageCondition,
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
    children: list[ConditionNode | GroupNode | NotNode] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "type": self.type,
            "logic": self.logic.value,
            "children": [child.to_dict() if hasattr(child, "to_dict") else child for child in self.children],
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> GroupNode:
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
    child: ConditionNode | GroupNode = field(default_factory=lambda: ContentCondition())

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "type": self.type,
            "child": self.child.to_dict() if hasattr(self.child, "to_dict") else self.child,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> NotNode:
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
    id: str | None = None  # Stable identifier for query identity
    created_at: str | None = None
    updated_at: str | None = None
    description: str | None = None

    # System queries are read-only (e.g., linked references, child pages)
    is_system: bool | None = None

    def to_dict(self) -> dict[str, Any]:
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
    def from_dict(data: dict[str, Any]) -> QueryAST:
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


def condition_from_dict(data: dict[str, Any]) -> ConditionNode:
    """Create a ConditionNode from dictionary based on condition_type."""
    condition_type = ConditionType(data.get("condition_type", "content"))

    if condition_type == ConditionType.CLASS:
        return ClassCondition(
            class_uuid=data.get("class_uuid", ""),
            class_id=data.get("class_id"),
            operator=data.get("operator"),
        )
    elif condition_type == ConditionType.EXTENDS:
        return ExtendsCondition(
            extends_class_uuid=data.get("extends_class_uuid", ""),
            extends_class_id=data.get("extends_class_id"),
        )
    elif condition_type == ConditionType.PROPERTY:
        return PropertyCondition(
            property_name=data.get("property_name", ""),
            property_uuid=data.get("property_uuid"),
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
    elif condition_type == ConditionType.STYLE:
        return StyleCondition(
            style_type=StyleType(data.get("style_type", "bold")),
            operator=StyleOperator(data.get("operator", "contains")),
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
        return ReferencePathCondition(
            target_uuids=data.get("target_uuids"),
            target_ids=data.get("target_ids"),
            nested_group=nested_group,
        )
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
            parent_uuids=data.get("parent_uuids"),
            parent_id=data.get("parent_id"),
            parent_ids=data.get("parent_ids"),
            operator=data.get("operator", "has_parent"),
            nested_group=nested_group,
        )
    elif condition_type == ConditionType.FLAG:
        return FlagCondition(
            flag_name=data.get("flag_name", ""),
            value=data.get("value", True),
        )
    elif condition_type == ConditionType.CHILD:
        nested_group = None
        if "nested_group" in data and data["nested_group"]:
            nested_group = GroupNode.from_dict(data["nested_group"])
        return ChildCondition(
            child_uuids=data.get("child_uuids"),
            child_ids=data.get("child_ids"),
            nested_group=nested_group,
            operator=data.get("operator", "has_child"),
        )
    elif condition_type == ConditionType.CHILD_PATH:
        nested_group = None
        if "nested_group" in data and data["nested_group"]:
            nested_group = GroupNode.from_dict(data["nested_group"])
        return ChildPathCondition(
            nested_group=nested_group,
            max_depth=data.get("max_depth"),
            operator=data.get("operator", "has_descendant"),
        )
    elif condition_type == ConditionType.PAGE:
        nested_group = None
        if "nested_group" in data and data["nested_group"]:
            nested_group = GroupNode.from_dict(data["nested_group"])
        return PageCondition(
            page_uuid=data.get("page_uuid"),
            page_uuids=data.get("page_uuids"),
            page_id=data.get("page_id"),
            page_ids=data.get("page_ids"),
            nested_group=nested_group,
            operator=data.get("operator", "is_page"),
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
