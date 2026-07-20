"""Bootstrap core domain-service ports for plugins.

This module registers the ports that plugins receive through
:class:`app.plugins.core.context.PluginContext`. During Phase 7 the legacy
mutable-row ports (``NodeService``, ``PropertyService``, ``NodeRepository``) are
replaced by :class:`app.core.workspace_store.WorkspaceStore`, which lets plugin
code read from derived SQLite and emit operations into the local-first log.

The global settings repository remains available for workspace-scoped plugin
settings until those migrate to the operation log.
"""

from __future__ import annotations

from app.core.workspace_store import WorkspaceStore
from app.db.connection import get_pool
from app.domain.repositories.interfaces import SettingsRepository
from app.domain.repositories.postgres_settings import PostgresSettingsRepository
from app.relay.dependencies import get_relay_storage

from .manager import plugin_manager


async def _workspace_store_factory(
    workspace_uuid: str, actor_uuid: str
) -> WorkspaceStore:
    """Create a WorkspaceStore scoped to ``(workspace_uuid, actor_uuid)``."""
    return WorkspaceStore(
        workspace_id=workspace_uuid,
        actor_id=actor_uuid,
        relay_storage=get_relay_storage(),
    )


async def _settings_repository_factory(
    _workspace_id: int, _user_id: int
) -> SettingsRepository:
    """Create a SettingsRepository (global per pool).

    The integer workspace/user ids are accepted for port compatibility but the
    repository instance itself is not scoped to a workspace.
    """
    pool = await get_pool()
    return PostgresSettingsRepository(pool)


def register_core_ports() -> None:
    """Register core domain-service factories with the plugin manager."""
    plugin_manager.register_port("WorkspaceStore", _workspace_store_factory)
    plugin_manager.register_port("SettingsRepository", _settings_repository_factory)
