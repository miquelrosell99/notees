"""Repository utilities and base classes.

Common patterns extracted from PostgreSQL repositories:
- Base repository class with shared initialization
- Timestamp normalization for entity conversion
- Common query helpers
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import asyncpg


def normalize_timestamp(value: datetime | str | None) -> str:
    """Normalize timestamp to ISO string for entity conversion.

    Used in repository _row_to_* methods to handle both datetime
    and string representations from database.

    Args:
        value: datetime, ISO string, or None

    Returns:
        ISO 8601 string or empty string
    """
    if isinstance(value, datetime):
        return value.isoformat()
    return value or ""


class BasePostgresRepository:
    """Base class for PostgreSQL repositories.

    Provides common initialization pattern and utility methods
    shared across all repository implementations.

    Attributes:
        _pool: asyncpg connection pool
        _workspace_id: The workspace/tenant ID for multi-tenant queries
        _user_id: Optional user ID for audit trails and permissions
    """

    def __init__(self, pool: asyncpg.Pool, workspace_id: int, user_id: int | None = None):
        """Initialize repository with connection pool and context.

        Args:
            pool: asyncpg connection pool
            workspace_id: The workspace this repository operates on
            user_id: Optional current user ID for audit trails
        """
        self._pool = pool
        self._workspace_id = workspace_id
        self._user_id = user_id

    def get_connection(self) -> asyncpg.Pool:
        """Get the underlying connection pool."""
        return self._pool

    @property
    def workspace_id(self) -> int:
        """Get the current workspace ID."""
        return self._workspace_id

    @property
    def user_id(self) -> int | None:
        """Get the current user ID."""
        return self._user_id

    @staticmethod
    def normalize_timestamp(value: datetime | str | None) -> str:
        """Normalize timestamp for entity conversion.

        Convenience method that calls the module-level function.
        """
        return normalize_timestamp(value)
