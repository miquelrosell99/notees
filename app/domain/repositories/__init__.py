"""Repository implementations package."""

from .interfaces import (
    CleanupRepository,
    PermissionRepository,
    QueryRepository,
    SettingsRepository,
    SystemSettingsRepository,
)
from .postgres_cleanup import PostgresCleanupRepository
from .postgres_permission import PostgresPermissionRepository
from .postgres_query import PostgresQueryRepository
from .postgres_settings import PostgresSettingsRepository
from .postgres_system_settings import PostgresSystemSettingsRepository

__all__ = [
    # Interfaces
    "CleanupRepository",
    "PermissionRepository",
    "QueryRepository",
    "SettingsRepository",
    "SystemSettingsRepository",
    # PostgreSQL implementations
    "PostgresCleanupRepository",
    "PostgresPermissionRepository",
    "PostgresQueryRepository",
    "PostgresSettingsRepository",
    "PostgresSystemSettingsRepository",
]
