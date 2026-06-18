"""Domain entities package."""

from .class_extend import (
    ClassExtend,
)
from .link import (
    BacklinkInfo,
    NodeLink,
    NodeMention,
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
from .sync import (
    ClientNodeState,
    ServerNodeState,
    SyncConflict,
    SyncRequest,
    SyncResponse,
)
from .task_completion import TaskCompletion
from .task_recurrence import TaskRecurrence
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
    "NodeMention",
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
    "UuidBlock",
    "QueryAST",
    "NodeView",
    "QUERY_PLACEHOLDERS",
    # Sync
    "ClientNodeState",
    "ServerNodeState",
    "SyncConflict",
    "SyncRequest",
    "SyncResponse",
    # Task recurrence
    "TaskRecurrence",
    "TaskCompletion",
]
