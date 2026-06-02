"""Domain entities package."""

from .class_extend import (
    ClassExtend,
)
from .link import (
    BacklinkInfo,
    NodeLink,
)
from .node import (
    Node,
    NodeCreateData,
    NodeUpdateData,
    generate_uuid,
    utc_now_iso,
)
from .property import (
    ALWAYS_SINGLE_TYPES,
    RELATION_TYPES,
    SCALAR_TYPES,
    ClassProperty,
    NodeProperty,
    Property,
    PropertyClassFilter,
    PropertyScope,
    PropertySelectionLine,
    PropertyType,
    PropertyValueRelation,
    PropertyValueScalar,
    PropertyValueSelection,
)
from .query import (
    QUERY_PLACEHOLDERS,
    ChildBlock,
    ChildPathBlock,
    ClassBlock,
    ClassPathBlock,
    ContainerBlock,
    ContentBlock,
    ContentOperator,
    NodeView,
    NotBlock,
    ParentBlock,
    ParentPathBlock,
    PropertyBlock,
    PropertyOperator,
    QueryAST,
    QueryBlock,
    QueryBlockType,
    ReferenceBlock,
    ReferencePathBlock,
    UuidBlock,
)
from .user import (
    AuthenticatedUser,
    User,
    UserCreateData,
    UserCredentials,
)

__all__ = [
    # Node
    "Node",
    "NodeCreateData",
    "NodeUpdateData",
    "generate_uuid",
    "utc_now_iso",
    # Property
    "Property",
    "PropertyType",
    "PropertyScope",
    "PropertySelectionLine",
    "PropertyClassFilter",
    "ClassProperty",
    "NodeProperty",
    "PropertyValueScalar",
    "PropertyValueRelation",
    "PropertyValueSelection",
    "SCALAR_TYPES",
    "RELATION_TYPES",
    "ALWAYS_SINGLE_TYPES",
    # Link
    "BacklinkInfo",
    "NodeLink",
    # ClassExtend
    "ClassExtend",
    # User
    "User",
    "UserCreateData",
    "UserCredentials",
    "AuthenticatedUser",
    # Query
    "QueryBlockType",
    "PropertyOperator",
    "ContentOperator",
    "QueryBlock",
    "ContainerBlock",
    "NotBlock",
    "ClassBlock",
    "PropertyBlock",
    "ContentBlock",
    "ReferenceBlock",
    "ReferencePathBlock",
    "ParentBlock",
    "ParentPathBlock",
    "ChildBlock",
    "ChildPathBlock",
    "ClassPathBlock",
    "UuidBlock",
    "QueryAST",
    "NodeView",
    "QUERY_PLACEHOLDERS",
]
