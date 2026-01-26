"""Repository implementations package."""
from .interfaces import (
    NodeRepository,
    PropertyRepository,
    LinkRepository,
    UserRepository,
)
from .postgres_node import PostgresNodeRepository
from .postgres_property import PostgresPropertyRepository
from .postgres_link import PostgresLinkRepository, PostgresInlineClassRepository
from .postgres_user import PostgresUserRepository
from .postgres_node_view import PostgresNodeViewRepository


__all__ = [
    # Interfaces
    "NodeRepository",
    "PropertyRepository",
    "LinkRepository",
    "UserRepository",
    # PostgreSQL implementations
    "PostgresNodeRepository",
    "PostgresPropertyRepository",
    "PostgresLinkRepository",
    "PostgresInlineClassRepository",
    "PostgresUserRepository",
    "PostgresNodeViewRepository",
]
