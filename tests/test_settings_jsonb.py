"""Tests for native JSONB settings storage.

Verify that settings repositories and system settings helpers store booleans,
numbers, and lists as native JSONB values, and that the migration normalizes
legacy string-encoded values.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.domain.repositories import PostgresSettingsRepository
from app.system_settings import get_system_setting, set_system_setting

pytestmark = pytest.mark.asyncio


async def test_user_setting_stores_native_types(db_pool, test_user):
    """set_user_setting stores primitives as native JSONB."""
    repo = PostgresSettingsRepository(db_pool)
    user_id = int(test_user["id"])

    now = datetime(2026, 1, 1, tzinfo=UTC)
    await repo.set_user_setting(user_id, "native_bool", True, now)
    await repo.set_user_setting(user_id, "native_int", 42, now)
    await repo.set_user_setting(user_id, "native_list", [1, 2, 3], now)

    settings = await repo.get_user_settings(user_id)
    assert settings["native_bool"] is True
    assert settings["native_int"] == 42
    assert settings["native_list"] == [1, 2, 3]


async def test_workspace_setting_stores_native_types(db_pool, test_user):
    """set_workspace_setting stores primitives as native JSONB."""
    repo = PostgresSettingsRepository(db_pool)
    workspace_id = test_user["workspace_id"]
    user_id = int(test_user["id"])

    now = datetime(2026, 1, 1, tzinfo=UTC)
    await repo.set_workspace_setting(
        workspace_id, "native_bool", False, now, user_id
    )
    await repo.set_workspace_setting(
        workspace_id, "native_int", 0, now, user_id
    )

    settings = await repo.get_workspace_settings(workspace_id)
    assert settings["native_bool"] is False
    assert settings["native_int"] == 0


async def test_system_setting_stores_native_types():
    """set_system_setting stores primitives as native JSONB."""
    await set_system_setting("native_test_enabled", True)
    await set_system_setting("native_test_days", 7)

    assert await get_system_setting("native_test_enabled") is True
    assert await get_system_setting("native_test_days") == 7


async def test_normalize_settings_jsonb_migration(db_pool, test_user):
    """The migration converts legacy string-encoded settings to native JSONB."""
    workspace_id = test_user["workspace_id"]
    user_id = int(test_user["id"])

    async with db_pool.acquire() as conn:
        # Insert legacy string-encoded JSONB values directly as SQL literals.
        await conn.execute(
            """
            INSERT INTO setting_workspace (workspace_id, key, value, create_date, write_date)
            VALUES ($1, 'trash_retention_days', '"30"'::jsonb, NOW(), NOW())
            ON CONFLICT (workspace_id, key) DO UPDATE SET value = '"30"'::jsonb, write_date = NOW()
            """,
            workspace_id,
        )
        await conn.execute(
            """
            INSERT INTO setting_workspace (workspace_id, key, value, create_date, write_date)
            VALUES ($1, 'activity_log_retention_enabled', '"false"'::jsonb, NOW(), NOW())
            ON CONFLICT (workspace_id, key) DO UPDATE SET value = '"false"'::jsonb, write_date = NOW()
            """,
            workspace_id,
        )
        await conn.execute(
            """
            INSERT INTO setting_user (user_id, key, value, create_date, write_date)
            VALUES ($1, 'favorites', '[1, 2, 3]'::jsonb, NOW(), NOW())
            ON CONFLICT (user_id, key) DO UPDATE SET value = '[1, 2, 3]'::jsonb, write_date = NOW()
            """,
            user_id,
        )

    from app.db.migrations.normalize_settings_jsonb import run as normalize_settings
    async with db_pool.acquire() as conn:
        await normalize_settings(conn)

    repo = PostgresSettingsRepository(db_pool)
    ws_settings = await repo.get_workspace_settings(workspace_id)
    assert ws_settings["trash_retention_days"] == 30
    assert ws_settings["activity_log_retention_enabled"] is False

    user_settings = await repo.get_user_settings(user_id)
    assert user_settings["favorites"] == [1, 2, 3]
