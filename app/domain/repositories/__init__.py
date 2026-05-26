"""Repository implementations package."""
from .interfaces import (
    ActivityRepository,
    LinkRepository,
    NodeRepository,
    PropertyRepository,
    SettingsRepository,
    ShareRepository,
    UserRepository,
)
from .postgres_activity import PostgresActivityRepository
from .postgres_link import PostgresLinkRepository
from .postgres_node import PostgresNodeRepository
from .postgres_node_view import PostgresNodeViewRepository
from .postgres_property import PostgresPropertyRepository
from .postgres_settings import PostgresSettingsRepository
from .postgres_share import PostgresShareRepository
from .postgres_user import PostgresUserRepository

__all__ = [
    # Interfaces
    "NodeRepository",
    "PropertyRepository",
    "LinkRepository",
    "UserRepository",
    "ActivityRepository",
    "SettingsRepository",
    "ShareRepository",
    # PostgreSQL implementations
    "PostgresNodeRepository",
    "PostgresPropertyRepository",
    "PostgresLinkRepository",
    "PostgresUserRepository",
    "PostgresNodeViewRepository",
    "PostgresActivityRepository",
    "PostgresSettingsRepository",
    "PostgresShareRepository",
]
