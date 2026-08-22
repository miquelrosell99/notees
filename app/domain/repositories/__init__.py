"""Repository interfaces and the PostgreSQL permission adapter."""

from .interfaces import (
    CleanupRepository,
    PermissionRepository,
    SettingsRepository,
    SystemSettingsRepository,
)
from .postgres_permission import PostgresPermissionRepository

__all__ = [
    # Interfaces
    "CleanupRepository",
    "PermissionRepository",
    "SettingsRepository",
    "SystemSettingsRepository",
    # PostgreSQL implementations
    "PostgresPermissionRepository",
]
