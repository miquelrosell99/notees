"""Domain entities package."""

from .node import (
    Node,
    NodeCreateData,
    NodeUpdateData,
    generate_uuid,
    utc_now_iso,
)
from .property import (
    Property,
    PropertyType,
    PropertySelectionLine,
    PropertyTypeFilter,
    TypeProperty,
    TypeExtend,
    TypeExtends,  # Legacy alias
    NodeProperty,
    PropertyValueScalar,
    PropertyValueRelation,
    PropertyValueSelection,
    SCALAR_TYPES,
    RELATION_TYPES,
    ALWAYS_SINGLE_TYPES,
)
from .link import (
    NodeLink,
    InlineType,
    BacklinkInfo,
)
from .user import (
    User,
    UserCreateData,
    UserCredentials,
    AuthenticatedUser,
)
from .query import (
    QueryBlockType,
    PropertyOperator,
    ContentOperator,
    QueryBlock,
    ContainerBlock,
    NotBlock,
    TypeBlock,
    PropertyBlock,
    ContentBlock,
    ReferenceBlock,
    ReferencePathBlock,
    AncestorPathBlock,
    UuidBlock,
    QueryBlockTree,
    NodeView,
    QUERY_PLACEHOLDERS,
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
    "PropertySelectionLine",
    "PropertyTypeFilter",
    "TypeProperty",
    "TypeExtend",
    "TypeExtends",  # Legacy alias
    "NodeProperty",
    "PropertyValueScalar",
    "PropertyValueRelation",
    "PropertyValueSelection",
    "SCALAR_TYPES",
    "RELATION_TYPES",
    "ALWAYS_SINGLE_TYPES",
    # Link
    "NodeLink",
    "InlineType",
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
    "TypeBlock",
    "PropertyBlock",
    "ContentBlock",
    "ReferenceBlock",
    "ReferencePathBlock",
    "AncestorPathBlock",
    "UuidBlock",
    "QueryBlockTree",
    "NodeView",
    "QUERY_PLACEHOLDERS",
]
