"""Basic sanity tests for Notees application.

These tests verify the application can start and basic endpoints work.
"""
import pytest
from httpx import AsyncClient


class TestAppHealth:
    """Test basic application health."""

    @pytest.mark.asyncio
    async def test_app_starts(self, client: AsyncClient):
        """Verify the application starts and responds."""
        response = await client.get("/")
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_manifest_exists(self, client: AsyncClient):
        """Verify PWA manifest is accessible (only after React build)."""
        response = await client.get("/manifest.json")
        # Manifest may not exist if React app hasn't been built yet
        assert response.status_code in [200, 404]
        if response.status_code == 200:
            assert "application/json" in response.headers.get("content-type", "")


class TestAuthEndpoints:
    """Test authentication endpoints exist."""

    @pytest.mark.asyncio
    async def test_login_endpoint_exists(self, client: AsyncClient):
        """Verify login endpoint is accessible."""
        response = await client.post(
            "/api/auth/login",
            json={"email": "nonexistent@example.com", "password": "wrong"}
        )
        # Should return 401, not 404
        assert response.status_code in [401, 422]

    @pytest.mark.asyncio
    async def test_register_endpoint_exists(self, client: AsyncClient):
        """Verify register endpoint is accessible."""
        response = await client.post(
            "/api/auth/register",
            json={"email": "validuser@example.com", "password": "validpass123"}
        )
        # Should succeed or return validation error, not 404
        # Note: Empty email may cause 400/422/500 depending on validation
        assert response.status_code != 404


class TestProtectedEndpoints:
    """Test that protected endpoints require authentication."""

    @pytest.mark.asyncio
    async def test_nodes_requires_auth(self, client: AsyncClient):
        """Verify nodes endpoint requires authentication."""
        response = await client.get("/api/nodes/")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_workspaces_requires_auth(self, client: AsyncClient):
        """Verify workspaces endpoint requires authentication."""
        response = await client.get("/api/workspaces/")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_sync_requires_auth(self, client: AsyncClient):
        """Verify sync endpoint requires authentication."""
        response = await client.post("/api/sync", json={})
        assert response.status_code == 401
