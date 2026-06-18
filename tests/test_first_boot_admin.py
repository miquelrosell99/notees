"""Regression tests for first-boot admin creation.

Ensures the first admin can only be created via /auth/register when the
configured ADMIN_PASSWORD is supplied, and that the resulting admin's password
matches ADMIN_PASSWORD (not the registrant's chosen password).
"""
import secrets

import pytest
from httpx import AsyncClient

from app.config import settings
from app.features.auth import auth

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_first_boot_register_requires_admin_password(client: AsyncClient):
    """First /auth/register must include the configured ADMIN_PASSWORD."""
    email = f"firstadmin_{secrets.token_hex(4)}@example.com"
    response = await client.post(
        "/api/auth/register",
        json={"email": email, "password": "UserPass123!"},
    )
    assert response.status_code == 403
    assert "admin password" in response.json().get("detail", "").lower()


@pytest.mark.asyncio
async def test_first_boot_register_rejects_wrong_admin_password(client: AsyncClient):
    """First /auth/register rejects a mismatched ADMIN_PASSWORD."""
    email = f"firstadmin_{secrets.token_hex(4)}@example.com"
    response = await client.post(
        "/api/auth/register",
        json={"email": email, "password": "UserPass123!", "admin_password": "WrongPass123!"},
    )
    assert response.status_code == 403
    assert "does not match" in response.json().get("detail", "").lower()


@pytest.mark.asyncio
async def test_first_boot_register_creates_admin_with_admin_password(client: AsyncClient):
    """Successful first /auth/register creates an admin whose password is ADMIN_PASSWORD."""
    email = f"firstadmin_{secrets.token_hex(4)}@example.com"
    user_password = "UserPass123!"
    admin_password = settings.admin_password
    assert admin_password

    response = await client.post(
        "/api/auth/register",
        json={"email": email, "password": user_password, "admin_password": admin_password},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["user"]["email"] == email
    assert data["user"]["role"] == "admin"

    # The admin password must be ADMIN_PASSWORD, not the registrant's password.
    user = await auth.authenticate_user(email, admin_password)
    assert user is not None

    # Logging in with the registrant's chosen password must fail.
    user_with_user_pass = await auth.authenticate_user(email, user_password)
    assert user_with_user_pass is None
