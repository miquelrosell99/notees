"""Unit tests for the deprecated undo router.

The server-side undo/redo stack was removed in Phase 7. All endpoints under
``/undo`` must return ``410 Gone`` with a clear deprecation message.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.dependencies import get_current_user, require_read_or_write_scope, require_write_scope
from app.features.undo.router import router as undo_router
from app.models import User

pytestmark = pytest.mark.unit


async def _override_get_current_user() -> User:
    return User(
        id="1",
        uuid="user-uuid-1",
        email="test@example.com",
        role="user",
        created_at=datetime.now(UTC),
    )


async def _override_require_scope() -> User:
    return await _override_get_current_user()


@pytest_asyncio.fixture
async def undo_client() -> AsyncGenerator[AsyncClient, None]:
    """Authenticated test client with the deprecated undo router mounted."""
    test_app = FastAPI()
    test_app.include_router(undo_router)
    test_app.dependency_overrides[get_current_user] = _override_get_current_user
    test_app.dependency_overrides[require_read_or_write_scope] = _override_require_scope
    test_app.dependency_overrides[require_write_scope] = _override_require_scope

    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


class TestUndoDeprecated:
    async def test_post_undo_returns_gone(self, undo_client: AsyncClient) -> None:
        response = await undo_client.post("/undo/undo")
        assert response.status_code == 410
        detail = response.json()["detail"]
        assert "deprecated" in detail["message"].lower() or "no longer" in detail["message"].lower()

    async def test_post_redo_returns_gone(self, undo_client: AsyncClient) -> None:
        response = await undo_client.post("/undo/redo")
        assert response.status_code == 410

    async def test_get_stack_returns_gone(self, undo_client: AsyncClient) -> None:
        response = await undo_client.get("/undo/stack")
        assert response.status_code == 410

    async def test_post_undo_to_returns_gone(self, undo_client: AsyncClient) -> None:
        response = await undo_client.post("/undo/undo-to/entry-uuid-1")
        assert response.status_code == 410

    async def test_post_redo_to_returns_gone(self, undo_client: AsyncClient) -> None:
        response = await undo_client.post("/undo/redo-to/entry-uuid-1")
        assert response.status_code == 410

    async def test_delete_history_returns_gone(self, undo_client: AsyncClient) -> None:
        response = await undo_client.delete("/undo/history")
        assert response.status_code == 410
