"""Tests for push notification device token registration."""

import pytest


@pytest.mark.integration
async def test_register_device_token(authenticated_client):
    """An authenticated user can register a device token."""
    response = await authenticated_client.post(
        "/api/auth/device-token",
        json={"token": "test-fcm-token-123", "platform": "android"},
    )
    assert response.status_code == 200
    assert response.json()["success"] is True


@pytest.mark.integration
async def test_register_device_token_requires_auth(client):
    """Device token registration requires authentication."""
    response = await client.post(
        "/api/auth/device-token",
        json={"token": "test-fcm-token-123", "platform": "android"},
    )
    assert response.status_code == 401
