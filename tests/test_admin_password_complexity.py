"""Tests for admin user update password complexity enforcement."""
import secrets

import pytest
import pytest_asyncio
from httpx import AsyncClient

from app import auth
from app.main import app


@pytest_asyncio.fixture
async def admin_user(db_pool) -> dict:
    """Create an admin user and return auth data."""
    unique_id = secrets.token_hex(4)
    email = f"admin_{unique_id}@example.com"
    user = await auth.create_user(
        email=email,
        password="AdminPass1!",
        name="Admin",
        role="admin",
    )
    token = auth.create_token(user["id"], user["email"], user["role"])
    return {
        "id": user["id"],
        "email": user["email"],
        "token": token,
        "auth_header": {"Authorization": f"Bearer {token}"},
    }


@pytest_asyncio.fixture
async def authenticated_admin_client(client: AsyncClient, admin_user: dict) -> AsyncClient:
    """Return an HTTP client authenticated as an admin user."""
    client.headers.update(admin_user["auth_header"])
    return client


@pytest.mark.asyncio
async def test_admin_update_user_rejects_weak_password(
    authenticated_admin_client: AsyncClient,
    test_user: dict,
):
    """Admin updating a user's password must enforce complexity policy."""
    target_user_id = test_user["id"]
    weak_passwords = [
        "short1!",  # too short
        "nouppercase123!",  # missing uppercase
        "NOLOWERCASE123!",  # missing lowercase
        "NoSpecialChar123",  # missing special character
        "NoDigits!Abc",  # missing digit
    ]

    for weak_password in weak_passwords:
        response = await authenticated_admin_client.put(
            f"/api/admin/users/{target_user_id}",
            json={"password": weak_password},
        )
        assert response.status_code == 422, (
            f"Expected 422 for password {weak_password!r}, got {response.status_code}"
        )
        data = response.json()
        assert "error" in data
        assert data["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.asyncio
async def test_admin_update_user_accepts_strong_password(
    authenticated_admin_client: AsyncClient,
    test_user: dict,
):
    """Admin updating a user's password succeeds with a strong password."""
    target_user_id = test_user["id"]
    response = await authenticated_admin_client.put(
        f"/api/admin/users/{target_user_id}",
        json={"password": "Str0ng!Pass"},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["id"] == str(target_user_id)
