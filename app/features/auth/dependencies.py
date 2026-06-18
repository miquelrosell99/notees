"""FastAPI dependencies for the auth feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import asyncpg

from app.db.connection import get_pool
from app.features.auth.port import InviteRepository, UserRepository
from app.features.auth.repository import PostgresInviteRepository, PostgresUserRepository


def _make_invite_repository(pool: asyncpg.Pool) -> InviteRepository:
    return PostgresInviteRepository(pool)


async def get_invite_repository() -> AsyncGenerator[InviteRepository, None]:
    """Get an InviteRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield _make_invite_repository(pool)


def _make_user_repository(pool: asyncpg.Pool) -> UserRepository:
    return PostgresUserRepository(pool)


async def get_user_repository() -> AsyncGenerator[UserRepository, None]:
    """Get a UserRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield _make_user_repository(pool)
