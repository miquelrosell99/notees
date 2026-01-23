"""Repository utilities and base classes.

Common patterns extracted from PostgreSQL repositories:
- Base repository class with shared initialization
- Timestamp normalization for entity conversion
- Common query helpers
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional, TYPE_CHECKING

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
        _graph_id: The graph/tenant ID for multi-tenant queries
        _user_id: Optional user ID for audit trails and permissions
    """
    
    def __init__(
        self, 
        pool: "asyncpg.Pool", 
        graph_id: int, 
        user_id: Optional[int] = None
    ):
        """Initialize repository with connection pool and context.
        
        Args:
            pool: asyncpg connection pool
            graph_id: The graph this repository operates on
            user_id: Optional current user ID for audit trails
        """
        self._pool = pool
        self._graph_id = graph_id
        self._user_id = user_id
    
    def get_connection(self) -> "asyncpg.Pool":
        """Get the underlying connection pool."""
        return self._pool
    
    @property
    def graph_id(self) -> int:
        """Get the current graph ID."""
        return self._graph_id
    
    @property
    def user_id(self) -> Optional[int]:
        """Get the current user ID."""
        return self._user_id
    
    @staticmethod
    def normalize_timestamp(value: datetime | str | None) -> str:
        """Normalize timestamp for entity conversion.
        
        Convenience method that calls the module-level function.
        """
        return normalize_timestamp(value)
