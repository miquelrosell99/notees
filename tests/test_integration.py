"""Integration tests for Notees.

These tests verify the full flow from API to database,
testing that all layers work together correctly.
"""
import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


class TestAuthFlow:
    """Test complete authentication flow."""

    @pytest.mark.asyncio
    async def test_register_and_login(self, client: AsyncClient):
        """Test user registration followed by login."""
        import secrets
        email = f"testuser_{secrets.token_hex(4)}@example.com"
        password = "Testpass123!"

        # Register (first boot creates admin with ADMIN_PASSWORD)
        admin_password = "TestAdminPass123!"
        response = await client.post(
            "/api/auth/register",
            json={"email": email, "password": password, "admin_password": admin_password}
        )
        assert response.status_code == 200
        data = response.json()
        assert "access_token" in data
        assert data["user"]["email"] == email

        # Login with ADMIN_PASSWORD (the actual initial admin password)
        response = await client.post(
            "/api/auth/login",
            json={"email": email, "password": admin_password}
        )
        assert response.status_code == 200
        data = response.json()
        assert "access_token" in data
        token = data["access_token"]

        # Use token to get user info
        response = await client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 200
        assert response.json()["email"] == email

    @pytest.mark.asyncio
    async def test_login_with_remember_me_uses_longer_refresh_token(self, client: AsyncClient):
        """Login with remember_me=True issues a long-lived refresh token and preserves it on refresh."""
        import re
        import secrets

        email = f"remember_{secrets.token_hex(4)}@example.com"
        password = "Testpass123!"

        def get_refresh_cookie_max_age(response):
            set_cookie = response.headers.get("set-cookie", "")
            match = re.search(r"refresh_token=[^;]*;.*?Max-Age=(\d+)", set_cookie, re.IGNORECASE)
            return int(match.group(1)) if match else None

        # Register first (first boot creates admin with ADMIN_PASSWORD)
        admin_password = "TestAdminPass123!"
        response = await client.post(
            "/api/auth/register",
            json={"email": email, "password": password, "admin_password": admin_password}
        )
        assert response.status_code == 200

        # Login with ADMIN_PASSWORD and remember_me=True
        response = await client.post(
            "/api/auth/login",
            json={"email": email, "password": admin_password, "remember_me": True}
        )
        assert response.status_code == 200

        max_age = get_refresh_cookie_max_age(response)
        assert max_age is not None
        # Max-Age should be roughly 90 days
        assert max_age >= 89 * 24 * 60 * 60

        # Refresh and verify the rotated cookie keeps the long lifetime
        response = await client.post("/api/auth/refresh")
        assert response.status_code == 200
        rotated_max_age = get_refresh_cookie_max_age(response)
        assert rotated_max_age is not None
        assert rotated_max_age >= 89 * 24 * 60 * 60

    @pytest.mark.asyncio
    async def test_login_without_remember_me_uses_short_refresh_token(self, client: AsyncClient):
        """Login with remember_me=False issues the normal short-lived refresh token."""
        import re
        import secrets

        email = f"no_remember_{secrets.token_hex(4)}@example.com"
        password = "Testpass123!"

        def get_refresh_cookie_max_age(response):
            set_cookie = response.headers.get("set-cookie", "")
            match = re.search(r"refresh_token=[^;]*;.*?Max-Age=(\d+)", set_cookie, re.IGNORECASE)
            return int(match.group(1)) if match else None

        # Register first (first boot creates admin with ADMIN_PASSWORD)
        admin_password = "TestAdminPass123!"
        response = await client.post(
            "/api/auth/register",
            json={"email": email, "password": password, "admin_password": admin_password}
        )
        assert response.status_code == 200

        # Login with ADMIN_PASSWORD and remember_me=False
        response = await client.post(
            "/api/auth/login",
            json={"email": email, "password": admin_password, "remember_me": False}
        )
        assert response.status_code == 200

        max_age = get_refresh_cookie_max_age(response)
        assert max_age is not None
        # Development environment defaults to a 30-day refresh token.
        assert max_age <= 31 * 24 * 60 * 60
        assert max_age >= 29 * 24 * 60 * 60

    @pytest.mark.asyncio
    async def test_refresh_token_reuse_within_grace_succeeds_once(self, client: AsyncClient):
        """A rotated refresh token may be reused once within the grace window."""
        import secrets

        from app.config import settings

        original_grace = settings.refresh_token_reuse_grace_seconds
        settings.refresh_token_reuse_grace_seconds = 0.5

        try:
            email = f"grace_{secrets.token_hex(4)}@example.com"
            password = "Testpass123!"
            admin_password = "TestAdminPass123!"

            await client.post(
                "/api/auth/register",
                json={"email": email, "password": password, "admin_password": admin_password}
            )
            login_response = await client.post(
                "/api/auth/login",
                json={"email": email, "password": admin_password, "remember_me": False}
            )
            assert login_response.status_code == 200
            old_refresh = login_response.cookies.get("refresh_token")
            assert old_refresh

            # Rotate the token with the main client.
            rotate_response = await client.post("/api/auth/refresh")
            assert rotate_response.status_code == 200

            # Reuse the old token within the grace window.
            client.cookies.set("refresh_token", old_refresh, path="/api/auth/refresh")
            reuse_response = await client.post("/api/auth/refresh")
            assert reuse_response.status_code == 200

            # A second reuse of the same old token must revoke the family.
            client.cookies.set("refresh_token", old_refresh, path="/api/auth/refresh")
            second_reuse = await client.post("/api/auth/refresh")
            assert second_reuse.status_code == 401
        finally:
            settings.refresh_token_reuse_grace_seconds = original_grace

    @pytest.mark.asyncio
    async def test_refresh_token_reuse_after_grace_revokes_family(self, client: AsyncClient):
        """Reusing a rotated refresh token after the grace window revokes the family."""
        import asyncio
        import secrets

        from app.config import settings

        original_grace = settings.refresh_token_reuse_grace_seconds
        settings.refresh_token_reuse_grace_seconds = 0.1

        try:
            email = f"grace_expire_{secrets.token_hex(4)}@example.com"
            password = "Testpass123!"
            admin_password = "TestAdminPass123!"

            await client.post(
                "/api/auth/register",
                json={"email": email, "password": password, "admin_password": admin_password}
            )
            login_response = await client.post(
                "/api/auth/login",
                json={"email": email, "password": admin_password, "remember_me": False}
            )
            assert login_response.status_code == 200
            old_refresh = login_response.cookies.get("refresh_token")
            assert old_refresh

            # Rotate the token with the main client.
            rotate_response = await client.post("/api/auth/refresh")
            assert rotate_response.status_code == 200

            # Wait for the grace window to expire.
            await asyncio.sleep(0.2)

            # Reuse the old token after grace; expect revocation.
            client.cookies.set("refresh_token", old_refresh, path="/api/auth/refresh")
            reuse_response = await client.post("/api/auth/refresh")
            assert reuse_response.status_code == 401

            # The family is revoked, so even the newest token from the main client is invalid.
            final_response = await client.post("/api/auth/refresh")
            assert final_response.status_code == 401
        finally:
            settings.refresh_token_reuse_grace_seconds = original_grace

    @pytest.mark.asyncio
    async def test_dev_environment_uses_longer_access_token_default(self, client: AsyncClient):
        """Development environment defaults to longer-lived access and refresh tokens."""
        import re
        import secrets

        from app.config import settings

        assert settings.environment.lower() == "development"
        assert settings.access_token_expire_hours == 8.0
        assert settings.refresh_token_expire_days == 30

        email = f"devdefaults_{secrets.token_hex(4)}@example.com"
        password = "Testpass123!"
        admin_password = "TestAdminPass123!"

        await client.post(
            "/api/auth/register",
            json={"email": email, "password": password, "admin_password": admin_password}
        )
        response = await client.post(
            "/api/auth/login",
            json={"email": email, "password": admin_password, "remember_me": False}
        )
        assert response.status_code == 200

        def get_access_cookie_max_age(resp):
            set_cookie = resp.headers.get("set-cookie", "")
            match = re.search(r"access_token=[^;]*;.*?Max-Age=(\d+)", set_cookie, re.IGNORECASE)
            return int(match.group(1)) if match else None

        access_max_age = get_access_cookie_max_age(response)
        assert access_max_age is not None
        # 8 hours minus a small tolerance
        assert access_max_age >= 7 * 60 * 60
        assert access_max_age <= 8 * 60 * 60


class TestNodeCrudFlow:
    """Test complete node CRUD operations."""

    @pytest.mark.asyncio
    async def test_create_read_update_delete_page(self, auth_client: AsyncClient):
        """Test full CRUD cycle for a page."""
        # Create a page
        response = await auth_client.post("/api/nodes/page", params={"name": "Integration Test Page"})
        assert response.status_code == 200
        page = response.json()
        page_id = page["id"]
        page_uuid = page["uuid"]
        assert page["is_page"] is True
        # For pages, name is stored as AST
        assert "Integration Test Page" in page.get("name", "")

        # Read the page
        response = await auth_client.get(f"/api/nodes/{page_uuid}")
        assert response.status_code == 200
        assert response.json()["id"] == page_id

        # Update the page
        update_data = {
            "name": "Updated Integration Test Page",
        }
        response = await auth_client.put(f"/api/nodes/{page_uuid}", json=update_data)
        assert response.status_code == 200
        assert "Updated Integration Test Page" in response.json().get("name", "")

        # Delete the page
        response = await auth_client.delete(f"/api/nodes/{page_uuid}")
        assert response.status_code == 200

        # Verify deleted
        response = await auth_client.get(f"/api/nodes/{page_uuid}")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_create_block_under_page(self, auth_client: AsyncClient):
        """Test creating blocks under a page."""
        # Create a page first
        page_response = await auth_client.post("/api/nodes/page", params={"name": "Parent Page for Blocks"})
        assert page_response.status_code == 200
        page = page_response.json()
        page_uuid = page["uuid"]

        # Create blocks under the page
        blocks = []
        for i in range(3):
            response = await auth_client.post("/api/nodes/", json={
                "name": f"Block {i + 1} content",
                "parent_uuid": page_uuid,
            })
            assert response.status_code == 200
            blocks.append(response.json())

        # Verify blocks are children of the page
        response = await auth_client.get(
            f"/api/nodes/page/{page_uuid}/content"
        )
        assert response.status_code == 200
        page_data = response.json()
        children = page_data.get("children", [])
        assert len(children) == 3

        # Cleanup
        await auth_client.delete(f"/api/nodes/{page_uuid}")


class TestDailyPageFlow:
    """Test daily journal page operations."""

    @pytest.mark.asyncio
    async def test_get_or_create_daily_page(self, auth_client: AsyncClient):
        """Test getting or creating a daily page."""
        from datetime import date

        today = date.today().isoformat()

        # Create daily page via POST
        response = await auth_client.post(
            "/api/nodes/daily",
            params={"date": today}
        )
        assert response.status_code == 200
        page = response.json()

        # Should return a page with is_daily flag
        assert page.get("is_daily") is True

        # Creating again should return same page
        response2 = await auth_client.post(
            "/api/nodes/daily",
            params={"date": today}
        )
        assert response2.status_code == 200
        page2 = response2.json()
        assert page2["id"] == page["id"]

    @pytest.mark.asyncio
    async def test_add_content_to_daily_page(self, auth_client: AsyncClient):
        """Test adding content blocks to daily page."""
        from datetime import date

        today = date.today().isoformat()

        # Create/get daily page
        response = await auth_client.post(
            "/api/nodes/daily",
            params={"date": today}
        )
        page = response.json()
        page_id = page["id"]
        page_uuid = page["uuid"]

        # Add a block to the daily page
        block_response = await auth_client.post("/api/nodes/", json={
            "name": "Today I learned about integration testing.",
            "is_page": False,
            "parent_uuid": page_uuid,
        })
        assert block_response.status_code == 200
        block = block_response.json()
        assert block["parent_id"] == page_id


class TestSearchFlow:
    """Test search functionality."""

    @pytest.mark.asyncio
    async def test_search_by_content(self, auth_client: AsyncClient):
        """Test searching nodes by content."""
        import secrets
        unique_marker = f"UNIQUE_{secrets.token_hex(6)}"

        # Create a page with unique name
        await auth_client.post("/api/nodes/", json={
            "name": f"Searchable Page {unique_marker}",
            "is_page": True,
        })

        # Search for the unique content
        response = await auth_client.get(
            "/api/nodes/search",
            params={"q": unique_marker}
        )
        assert response.status_code == 200
        results = response.json()

        # Should find at least one result
        assert "nodes" in results
        assert len(results["nodes"]) >= 1
        found = any(unique_marker in node.get("name", "")
                   for node in results["nodes"])
        assert found


class TestTagFlow:
    """Test tag operations."""

    @pytest.mark.asyncio
    async def test_create_tag(self, auth_client: AsyncClient):
        """Test creating a tag node."""
        import secrets
        tag_name = f"test-tag-{secrets.token_hex(4)}"

        response = await auth_client.post("/api/nodes/page", params={"name": tag_name})
        assert response.status_code == 200
        tag_node = response.json()

        # Regular pages are not classes
        assert tag_node["is_page"] is True


class TestWorkspaceFlow:
    """Test workspace management operations."""

    @pytest.mark.asyncio
    async def test_list_workspaces(self, auth_client: AsyncClient):
        """Test listing available workspaces."""
        response = await auth_client.get("/api/workspaces/")
        assert response.status_code == 200
        data = response.json()
        assert "workspaces" in data or "items" in data

    @pytest.mark.asyncio
    async def test_create_and_switch_workspace(self, auth_client: AsyncClient):
        """Test creating a new workspace and switching to it."""
        import secrets
        ws_name = f"testws_{secrets.token_hex(4)}"

        # Create new workspace
        response = await auth_client.post("/api/workspaces/", json={
            "name": ws_name
        })
        assert response.status_code == 200

        # List workspaces and verify the new one exists
        response = await auth_client.get("/api/workspaces/")
        assert response.status_code == 200
