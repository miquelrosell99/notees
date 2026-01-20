"""Infrastructure layer package.

This package contains implementations of domain interfaces
that interact with external systems (databases, APIs, etc.).

Structure:
- repositories/: Repository implementations
- persistence/: Database adapters and connections

The infrastructure layer depends on the domain layer,
but the domain layer should NEVER depend on infrastructure.
"""

from .repositories import (
    NodeRepository,
    UserRepository,
    SQLiteNodeRepository,
    SQLiteUserRepository,
)

__all__ = [
    "NodeRepository",
    "UserRepository",
    "SQLiteNodeRepository",
    "SQLiteUserRepository",
]
