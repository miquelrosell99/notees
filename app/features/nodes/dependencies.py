"""FastAPI dependency factories for the nodes feature.

This module provides low-level repository factories used by
``app.dependencies``. FastAPI dependencies that require workspace
context remain in ``app.dependencies`` to avoid a circular import.
"""

from __future__ import annotations

import asyncpg

from app.domain.repositories.interfaces import PermissionRepository
from app.features.nodes.port import (
    ClassExtendRepository,
    LinkRepository,
    MentionRepository,
    NodeRepository,
    NodeViewRepository,
)
from app.features.nodes.repository import (
    PostgresClassExtendRepository,
    PostgresLinkRepository,
    PostgresMentionRepository,
    PostgresNodeRepository,
    PostgresNodeViewRepository,
)


def _make_node_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    page_class_id: int,
    user_id: int,
    permission_repo: PermissionRepository | None = None,
) -> NodeRepository:
    return PostgresNodeRepository(
        pool, workspace_id, page_class_id, user_id, permission_repository=permission_repo
    )


def _make_link_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> LinkRepository:
    return PostgresLinkRepository(pool, workspace_id, user_id)


def _make_mention_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> MentionRepository:
    return PostgresMentionRepository(pool, workspace_id, user_id)


def _make_class_extend_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> ClassExtendRepository:
    return PostgresClassExtendRepository(pool, workspace_id, user_id)


def _make_node_view_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: str,
) -> NodeViewRepository:
    return PostgresNodeViewRepository(pool, workspace_id, user_id)
