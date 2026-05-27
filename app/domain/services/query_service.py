"""Query execution service.

Re-exports QueryExecutor from the repository layer for backward compatibility.
The actual implementation lives in app.domain.repositories.postgres_query.
"""

from ..repositories.postgres_query import PostgresQueryRepository as QueryExecutor

__all__ = ["QueryExecutor"]
