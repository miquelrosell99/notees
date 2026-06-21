"""Bootstrap core domain-service ports for plugins.

This module registers factories that create workspace/user-scoped service
instances for plugin use. It lives in the plugin core so that the plugin
manager can be wired without introducing circular imports in app.main.
"""

from __future__ import annotations

from app.db.connection import get_pool
from app.domain.repositories.factories import make_user_repository
from app.domain.repositories.interfaces import PermissionRepository, SettingsRepository
from app.domain.repositories.postgres_permission import PostgresPermissionRepository
from app.domain.repositories.postgres_settings import PostgresSettingsRepository
from app.features.activity.repository import PostgresActivityRepository
from app.features.nodes.class_management_service import ClassManagementService
from app.features.nodes.dependencies import (
    _make_class_extend_repository,
    _make_link_repository,
    _make_mention_repository,
    _make_node_repository,
)
from app.features.nodes.link_service import LinkParsingService
from app.features.nodes.mention_service import MentionService
from app.features.nodes.node_service import NodeService
from app.features.nodes.port import NodeRepository
from app.features.properties.dependencies import _make_property_repository
from app.features.properties.service import PropertyService

from .manager import plugin_manager


def _make_permission_repository(pool, workspace_id: int, user_id: int) -> PermissionRepository:
    """Create a permission repository for the workspace/user."""
    return PostgresPermissionRepository(pool, workspace_id, user_id)


async def _node_repository_factory(workspace_id: int, user_id: int) -> NodeRepository:
    """Create a NodeRepository scoped to workspace/user."""
    pool = await get_pool()
    permission_repo = _make_permission_repository(pool, workspace_id, user_id)
    return _make_node_repository(
        pool, workspace_id, page_class_id=0, user_id=user_id, permission_repo=permission_repo
    )


async def _node_service_factory(workspace_id: int, user_id: int) -> NodeService:
    """Create a NodeService scoped to workspace/user."""
    pool = await get_pool()
    permission_repo = _make_permission_repository(pool, workspace_id, user_id)
    node_repo = _make_node_repository(
        pool, workspace_id, page_class_id=0, user_id=user_id, permission_repo=permission_repo
    )
    property_repo = _make_property_repository(pool, workspace_id, user_id)
    link_repo = _make_link_repository(pool, workspace_id, user_id)
    settings_repo = PostgresSettingsRepository(pool)
    activity_repo = PostgresActivityRepository(pool, workspace_id, user_id)
    class_extend_repo = _make_class_extend_repository(pool, workspace_id, user_id)
    user_repo = make_user_repository(pool)
    link_service = LinkParsingService(node_repo, link_repo)
    mention_repo = _make_mention_repository(pool, workspace_id, user_id)
    mention_service = MentionService(node_repo, mention_repo, link_repo, user_id=user_id)
    return NodeService(
        node_repo,
        property_repo,
        link_service,
        page_class_id=0,
        workspace_id=workspace_id,
        user_id=user_id,
        settings_repo=settings_repo,
        activity_repo=activity_repo,
        class_extend_repo=class_extend_repo,
        user_repository=user_repo,
        mention_service=mention_service,
        permission_repository=permission_repo,
    )


async def _property_service_factory(workspace_id: int, user_id: int) -> PropertyService:
    """Create a PropertyService scoped to workspace/user."""
    pool = await get_pool()
    property_repo = _make_property_repository(pool, workspace_id, user_id)
    node_repo = _make_node_repository(pool, workspace_id, 0, user_id)
    class_extend_repo = _make_class_extend_repository(pool, workspace_id, user_id)
    user_repo = make_user_repository(pool)
    return PropertyService(
        property_repo,
        node_repo,
        class_extend_repo,
        workspace_id=workspace_id,
        user_id=user_id,
        user_repository=user_repo,
    )


async def _class_management_service_factory(workspace_id: int, user_id: int) -> ClassManagementService:
    """Create a ClassManagementService scoped to workspace/user."""
    pool = await get_pool()
    node_repo = _make_node_repository(pool, workspace_id, 0, user_id)
    property_repo = _make_property_repository(pool, workspace_id, user_id)
    class_extend_repo = _make_class_extend_repository(pool, workspace_id, user_id)
    return ClassManagementService(workspace_id, node_repo, property_repo, class_extend_repo)


async def _settings_repository_factory(_workspace_id: int, _user_id: int) -> SettingsRepository:
    """Create a SettingsRepository (global per pool)."""
    pool = await get_pool()
    return PostgresSettingsRepository(pool)


def register_core_ports() -> None:
    """Register core domain-service factories with the plugin manager."""
    plugin_manager.register_port("NodeRepository", _node_repository_factory)
    plugin_manager.register_port("NodeService", _node_service_factory)
    plugin_manager.register_port("PropertyService", _property_service_factory)
    plugin_manager.register_port("ClassManagementService", _class_management_service_factory)
    plugin_manager.register_port("SettingsRepository", _settings_repository_factory)
