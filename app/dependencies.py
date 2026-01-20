"""Dependency injection for FastAPI routes.

This module provides FastAPI dependencies that wire up
the application layer (use cases) with the infrastructure layer (repositories).

It bridges the existing database module with the new architecture,
allowing gradual migration of endpoints.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncGenerator
from fastapi import Depends

from .routers.auth import get_current_user
from .models import User
from .db.connection import get_db
from .infrastructure import SQLiteNodeRepository, NodeRepository
from .application import (
    CreateNodeUseCase,
    GetNodeUseCase,
    UpdateNodeUseCase,
    DeleteNodeUseCase,
    ListNodesUseCase,
    SearchNodesUseCase,
    GetOrCreateDailyUseCase,
)


@asynccontextmanager
async def get_db_connection(user_id: str):
    """Context manager for database connections.
    
    Ensures the connection is properly closed after use.
    """
    conn = await get_db(user_id)
    try:
        yield conn
    finally:
        await conn.close()


async def get_node_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[NodeRepository, None]:
    """Get a NodeRepository for the current user's database.
    
    This dependency:
    1. Gets the current user from auth
    2. Opens their database connection
    3. Creates a SQLiteNodeRepository
    4. Yields it for use in the route
    5. Cleans up after the request
    """
    async with get_db_connection(user.id) as conn:
        yield SQLiteNodeRepository(conn)


# ==================== Use Case Dependencies ====================

async def get_create_node_use_case(
    repo: NodeRepository = Depends(get_node_repository)
) -> CreateNodeUseCase:
    """Get a CreateNodeUseCase with injected repository."""
    return CreateNodeUseCase(repo)


async def get_get_node_use_case(
    repo: NodeRepository = Depends(get_node_repository)
) -> GetNodeUseCase:
    """Get a GetNodeUseCase with injected repository."""
    return GetNodeUseCase(repo)


async def get_update_node_use_case(
    repo: NodeRepository = Depends(get_node_repository)
) -> UpdateNodeUseCase:
    """Get an UpdateNodeUseCase with injected repository."""
    return UpdateNodeUseCase(repo)


async def get_delete_node_use_case(
    repo: NodeRepository = Depends(get_node_repository)
) -> DeleteNodeUseCase:
    """Get a DeleteNodeUseCase with injected repository."""
    return DeleteNodeUseCase(repo)


async def get_list_nodes_use_case(
    repo: NodeRepository = Depends(get_node_repository)
) -> ListNodesUseCase:
    """Get a ListNodesUseCase with injected repository."""
    return ListNodesUseCase(repo)


async def get_search_nodes_use_case(
    repo: NodeRepository = Depends(get_node_repository)
) -> SearchNodesUseCase:
    """Get a SearchNodesUseCase with injected repository."""
    return SearchNodesUseCase(repo)


async def get_daily_use_case(
    repo: NodeRepository = Depends(get_node_repository)
) -> GetOrCreateDailyUseCase:
    """Get a GetOrCreateDailyUseCase with injected repository."""
    return GetOrCreateDailyUseCase(repo)
