"""Tests for the notifications router."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.integration
class TestNotificationsRouter:
    @pytest.mark.asyncio
    async def test_read_all_route_is_not_shadowed(self, authenticated_client: AsyncClient):
        """POST /notifications/read-all must not be matched by /{uuid}/read."""
        response = await authenticated_client.post("/api/notifications/read-all")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"
