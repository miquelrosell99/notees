"""Domain-specific errors.

These exceptions represent domain-level error conditions,
independent of how they're presented to users (HTTP status codes, etc.)
"""
from typing import Optional


class DomainError(Exception):
    """Base class for all domain errors."""
    
    def __init__(self, message: str, code: str = "DOMAIN_ERROR"):
        self.message = message
        self.code = code
        super().__init__(message)


# ==================== Node Errors ====================

class NodeError(DomainError):
    """Base class for node-related errors."""
    pass


class NodeNotFoundError(NodeError):
    """Raised when a node cannot be found."""
    
    def __init__(self, node_id: str):
        self.node_id = node_id
        super().__init__(
            message=f"Node not found: {node_id}",
            code="NODE_NOT_FOUND"
        )


class DuplicateNodeError(NodeError):
    """Raised when attempting to create a duplicate node."""
    
    def __init__(self, title: str):
        self.title = title
        super().__init__(
            message=f"A page with this title already exists: {title}",
            code="DUPLICATE_NODE"
        )


class InvalidNodeHierarchyError(NodeError):
    """Raised when a node hierarchy operation is invalid."""
    
    def __init__(self, message: str):
        super().__init__(message=message, code="INVALID_HIERARCHY")


class OptimisticLockError(NodeError):
    """Raised when a concurrent modification is detected.
    
    This happens when trying to update a node with an expected version
    that doesn't match the current version in the database.
    """
    
    def __init__(self, node_id: int, expected_version: int, actual_version: int):
        self.node_id = node_id
        self.expected_version = expected_version
        self.actual_version = actual_version
        super().__init__(
            message=f"Concurrent modification detected for node {node_id}. "
                    f"Expected version {expected_version}, but found {actual_version}",
            code="OPTIMISTIC_LOCK_CONFLICT"
        )


class NodeValidationError(NodeError):
    """Raised when node data fails validation."""
    
    def __init__(self, message: str, field: Optional[str] = None):
        self.field = field
        super().__init__(message=message, code="NODE_VALIDATION_ERROR")


class CircularReferenceError(NodeError):
    """Raised when a circular reference would be created."""
    
    def __init__(self, node_id: str, parent_id: str):
        self.node_id = node_id
        self.parent_id = parent_id
        super().__init__(
            message=f"Cannot set {parent_id} as parent of {node_id}: would create circular reference",
            code="CIRCULAR_REFERENCE"
        )


class SystemTypeConstraintError(NodeError):
    """Raised when an operation violates system type constraints.
    
    Examples:
    - Trying to add/remove day, month, year types manually
    - Trying to remove 'type' from system type nodes
    """
    
    def __init__(self, message: str):
        super().__init__(message=message, code="SYSTEM_TYPE_CONSTRAINT")


class DatePageDeletionError(NodeError):
    """Raised when trying to delete a month or year page that has active day children.
    
    Month and year pages are automatically created as parents for daily pages,
    and cannot be deleted while they have active daily page descendants.
    """
    
    def __init__(self, node_type: str, child_count: int):
        self.node_type = node_type
        self.child_count = child_count
        super().__init__(
            message=f"Cannot delete {node_type} page: it has {child_count} active day page(s). "
                    f"Delete all day pages first.",
            code="DATE_PAGE_HAS_CHILDREN"
        )


# ==================== User Errors ====================

class UserError(DomainError):
    """Base class for user-related errors."""
    pass


class UserNotFoundError(UserError):
    """Raised when a user cannot be found."""
    
    def __init__(self, identifier: str):
        self.identifier = identifier
        super().__init__(
            message=f"User not found: {identifier}",
            code="USER_NOT_FOUND"
        )


class DuplicateUsernameError(UserError):
    """Raised when attempting to create a user with an existing username."""
    
    def __init__(self, username: str):
        self.username = username
        super().__init__(
            message=f"Username already exists: {username}",
            code="DUPLICATE_USERNAME"
        )


class InvalidCredentialsError(UserError):
    """Raised when authentication fails."""
    
    def __init__(self):
        super().__init__(
            message="Invalid username or password",
            code="INVALID_CREDENTIALS"
        )


class InactiveUserError(UserError):
    """Raised when an inactive user attempts to authenticate."""
    
    def __init__(self, username: str):
        self.username = username
        super().__init__(
            message=f"User account is inactive: {username}",
            code="INACTIVE_USER"
        )


# ==================== Database/Workspace Errors ====================

class DatabaseError(DomainError):
    """Base class for database/workspace errors."""
    pass


class DatabaseNotFoundError(DatabaseError):
    """Raised when a database cannot be found."""
    
    def __init__(self, name: str):
        self.name = name
        super().__init__(
            message=f"Database not found: {name}",
            code="DATABASE_NOT_FOUND"
        )


class DuplicateDatabaseError(DatabaseError):
    """Raised when attempting to create a duplicate database."""
    
    def __init__(self, name: str):
        self.name = name
        super().__init__(
            message=f"Database already exists: {name}",
            code="DUPLICATE_DATABASE"
        )


# ==================== Sync Errors ====================

class SyncError(DomainError):
    """Base class for sync-related errors."""
    pass


class SyncConflictError(SyncError):
    """Raised when a sync conflict is detected."""
    
    def __init__(self, node_id: str, local_version: int, remote_version: int):
        self.node_id = node_id
        self.local_version = local_version
        self.remote_version = remote_version
        super().__init__(
            message=f"Sync conflict for node {node_id}: local v{local_version} vs remote v{remote_version}",
            code="SYNC_CONFLICT"
        )
