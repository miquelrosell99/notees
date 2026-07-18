"""Tests for the deprecated backend undo / redo endpoints.

The server-side undo stack was removed in Phase 7 as part of the migration to
the local-first operation log. Undo is now implemented client-side by
generating inverse operations. These tests verify that the legacy endpoints
return a clear ``410 Gone`` deprecation response.
"""

import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


class TestUndoDeprecated:
    async def test_undo_returns_gone(self, authenticated_client) -> None:
        response = await authenticated_client.post("/api/undo/undo")
        assert response.status_code == 410
        detail = response.json()["detail"]
        assert "deprecated" in detail["message"].lower() or "no longer" in detail["message"].lower()

    async def test_redo_returns_gone(self, authenticated_client) -> None:
        response = await authenticated_client.post("/api/undo/redo")
        assert response.status_code == 410

    async def test_stack_returns_gone(self, authenticated_client) -> None:
        response = await authenticated_client.get("/api/undo/stack")
        assert response.status_code == 410

    async def test_undo_to_returns_gone(self, authenticated_client) -> None:
        response = await authenticated_client.post("/api/undo/undo-to/entry-uuid-1")
        assert response.status_code == 410

    async def test_redo_to_returns_gone(self, authenticated_client) -> None:
        response = await authenticated_client.post("/api/undo/redo-to/entry-uuid-1")
        assert response.status_code == 410

    async def test_clear_history_returns_gone(self, authenticated_client) -> None:
        response = await authenticated_client.delete("/api/undo/history")
        assert response.status_code == 410
