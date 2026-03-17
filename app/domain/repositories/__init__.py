"""Repository implementations package."""
from .interfaces import (
    NodeRepository,
    PropertyRepository,
    LinkRepository,
    UserRepository,
    ActivityRepository,
    SettingsRepository,
)
from .postgres_node import PostgresNodeRepository

from .postgres_property import PostgresPropertyRepository
from .postgres_link import PostgresLinkRepository
from .postgres_user import PostgresUserRepository
from .postgres_node_view import PostgresNodeViewRepository
from .postgres_activity import PostgresActivityRepository
from .postgres_settings import PostgresSettingsRepository


__all__ = [
    # Interfaces
    "NodeRepository",
    "PropertyRepository",
    "LinkRepository",
    "UserRepository",
    "ActivityRepository",
    "SettingsRepository",
    # PostgreSQL implementations
    "PostgresNodeRepository",
    "PostgresPropertyRepository",
    "PostgresLinkRepository",
    "PostgresUserRepository",
    "PostgresNodeViewRepository",
    "PostgresActivityRepository",
    "PostgresSettingsRepository",
]
