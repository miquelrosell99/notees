"""System settings helpers.

Provides get/set functions for global system settings stored in the
setting_system table. Falls back to app.config values for unset keys.

These functions are thin convenience wrappers around
:class:`PostgresSystemSettingsRepository`. New callers should prefer
injecting :class:`SystemSettingsRepository` directly.
"""

from __future__ import annotations

from typing import Any

from .db.connection import get_pool
from .domain.repositories.factories import make_system_settings_repository
from .domain.repositories.interfaces import SystemSettingsRepository
from .logging_config import get_logger

logger = get_logger(__name__)


async def _repo() -> SystemSettingsRepository:
    return make_system_settings_repository(await get_pool())


async def get_system_setting(key: str, default: Any = None) -> Any:
    """Get a system setting by key.

    Returns the JSONB value from the database, or the provided default
    if the key does not exist.
    """
    repo = await _repo()
    return await repo.get(key, default)


async def set_system_setting(key: str, value: Any) -> None:
    """Set a system setting by key.

    Upserts the value into the setting_system table.
    """
    repo = await _repo()
    await repo.set(key, value)


async def get_all_system_settings() -> dict[str, Any]:
    """Get all system settings as a dictionary."""
    repo = await _repo()
    return await repo.get_all()
