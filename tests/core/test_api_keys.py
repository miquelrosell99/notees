"""Tests for API key management."""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import AsyncClient

from app.features.auth import auth as auth_module

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def api_key_record(test_user: dict) -> dict:
    """Create and return a fresh API key for the test user."""
    return await auth_module.create_api_key(
        int(test_user["id"]),
        "test-regenerate-key",
        scopes=["read", "write"],
    )


class TestApiKeyRegenerate:
    async def test_regenerate_api_key_rotates_secret(
        self,
        authenticated_client: AsyncClient,
        api_key_record: dict,
    ) -> None:
        old_key = api_key_record["key"]

        response = await authenticated_client.post(
            f"/api/auth/api-keys/{api_key_record['id']}/regenerate"
        )
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == api_key_record["id"]
        assert data["name"] == "test-regenerate-key"
        assert data["key"] != old_key
        assert data["key"].startswith("nk_")
        assert set(data["scopes"]) == {"read", "write"}

        # Old key should no longer authenticate
        unauth_client = AsyncClient(
            transport=authenticated_client._transport,
            base_url=str(authenticated_client.base_url),
        )
        unauth_client.headers["X-API-Key"] = old_key
        me_response = await unauth_client.get("/api/auth/me")
        assert me_response.status_code == 401
        await unauth_client.aclose()

        # New key should authenticate successfully
        auth_client = AsyncClient(
            transport=authenticated_client._transport,
            base_url=str(authenticated_client.base_url),
        )
        auth_client.headers["X-API-Key"] = data["key"]
        me_response = await auth_client.get("/api/auth/me")
        assert me_response.status_code == 200
        await auth_client.aclose()

    async def test_regenerate_unknown_key_returns_404(
        self, authenticated_client: AsyncClient
    ) -> None:
        response = await authenticated_client.post(
            "/api/auth/api-keys/00000000-0000-0000-0000-000000000000/regenerate"
        )
        assert response.status_code == 404

    async def test_regenerate_revoked_key_returns_404(
        self,
        authenticated_client: AsyncClient,
        api_key_record: dict,
        test_user: dict,
    ) -> None:
        await auth_module.revoke_api_key(int(test_user["id"]), api_key_record["id"])

        response = await authenticated_client.post(
            f"/api/auth/api-keys/{api_key_record['id']}/regenerate"
        )
        assert response.status_code == 404
