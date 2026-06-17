"""Tests for page privacy enforcement and public share static HTML.

These tests verify:
1. Page privacy (is_private flag) is enforced
2. Public share static HTML files are generated, served, regenerated, and cleaned up
3. PermissionChecker returns correct permissions based on is_private
"""

import pytest
from httpx import AsyncClient

from app import auth
from app.db.connection import get_data_dir
from app.domain.entities import NodeUpdateData
from app.domain.permissions import PermissionChecker, Permissions
from app.domain.repositories import PostgresPermissionRepository
from app.node_export import get_static_share_path


class TestPagePrivacy:
    """Test page privacy: is_private flag."""

    @pytest.mark.asyncio
    async def test_private_page_inaccessible_to_other_workspace_member(
        self,
        authenticated_client: AsyncClient,
        test_user: dict,
        db_pool,
        client: AsyncClient,
    ):
        """A private page should return 404 for non-owners in the same workspace."""
        # Create a page as the owner
        create_resp = await authenticated_client.post("/api/nodes/page", params={"name": "Private Page"})
        assert create_resp.status_code == 200
        page = create_resp.json()
        page_id = page["id"]

        # Set page to private
        update_resp = await authenticated_client.put(
            f"/api/nodes/{page_id}", json={"is_private": True}
        )
        assert update_resp.status_code == 200

        # Create another user and add them to the workspace
        other_user = await auth.create_user("other_member@example.com", "password123")
        async with db_pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO workspace_share
                    (workspace_id, user_id, can_read, can_write, can_create, can_delete, active, create_uid)
                VALUES ($1, $2, TRUE, FALSE, FALSE, FALSE, TRUE, $3)
                ON CONFLICT (workspace_id, user_id) DO NOTHING
                """,
                test_user["workspace_id"],
                int(other_user["id"]),
                int(test_user["id"]),
            )

        # Authenticate as the other user
        other_token = auth.create_token(other_user["id"], other_user["email"], other_user["role"])
        other_client = client
        other_client.headers.update({"Authorization": f"Bearer {other_token}"})

        # Attempt to read the private page
        get_resp = await other_client.get(f"/api/nodes/{page_id}")
        assert get_resp.status_code == 404

        # Clean up other client headers
        del other_client.headers["Authorization"]

    @pytest.mark.asyncio
    async def test_private_page_accessible_to_owner(
        self,
        authenticated_client: AsyncClient,
    ):
        """The owner should be able to read their private page."""
        create_resp = await authenticated_client.post("/api/nodes/page", params={"name": "Owner Private Page"})
        assert create_resp.status_code == 200
        page = create_resp.json()
        page_id = page["id"]

        update_resp = await authenticated_client.put(
            f"/api/nodes/{page_id}", json={"is_private": True}
        )
        assert update_resp.status_code == 200

        get_resp = await authenticated_client.get(f"/api/nodes/{page_id}")
        assert get_resp.status_code == 200
        data = get_resp.json()
        assert data["id"] == page_id
        assert data["is_private"] is True

    @pytest.mark.asyncio
    async def test_workspace_page_accessible_to_workspace_member(
        self,
        authenticated_client: AsyncClient,
        test_user: dict,
        db_pool,
        client: AsyncClient,
    ):
        """A workspace-visible page should be readable by workspace members."""
        create_resp = await authenticated_client.post("/api/nodes/page", params={"name": "Workspace Page"})
        assert create_resp.status_code == 200
        page = create_resp.json()
        page_id = page["id"]

        # Default is not private; ensure it explicitly
        update_resp = await authenticated_client.put(
            f"/api/nodes/{page_id}", json={"is_private": False}
        )
        assert update_resp.status_code == 200

        # Create another user and add them to the workspace with read permission
        other_user = await auth.create_user("workspace_member@example.com", "password123")
        async with db_pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO workspace_share
                    (workspace_id, user_id, can_read, can_write, can_create, can_delete, active, create_uid)
                VALUES ($1, $2, TRUE, FALSE, FALSE, FALSE, TRUE, $3)
                ON CONFLICT (workspace_id, user_id) DO NOTHING
                """,
                test_user["workspace_id"],
                int(other_user["id"]),
                int(test_user["id"]),
            )

        other_token = auth.create_token(other_user["id"], other_user["email"], other_user["role"])
        other_client = client
        other_client.headers.update({"Authorization": f"Bearer {other_token}"})

        get_resp = await other_client.get(f"/api/nodes/{page_id}")
        assert get_resp.status_code == 200
        data = get_resp.json()
        assert data["id"] == page_id
        assert data["is_private"] is False

        del other_client.headers["Authorization"]

    @pytest.mark.asyncio
    async def test_public_page_accessible_via_public_share_api(
        self,
        authenticated_client: AsyncClient,
        client: AsyncClient,
    ):
        """A public page should be accessible via the public share API when shared."""
        create_resp = await authenticated_client.post("/api/nodes/page", params={"name": "Public Page"})
        assert create_resp.status_code == 200
        page = create_resp.json()
        page_id = page["id"]

        update_resp = await authenticated_client.put(
            f"/api/nodes/{page_id}", json={"is_private": False}
        )
        assert update_resp.status_code == 200

        # Create a public share for the page
        share_resp = await authenticated_client.post(f"/api/nodes/{page_id}/shares", json={})
        assert share_resp.status_code == 200
        share_data = share_resp.json()
        share_uuid = share_data["share_uuid"]

        # Access via public API without authentication
        public_resp = await client.get(f"/api/public/n/{share_uuid}")
        assert public_resp.status_code == 200
        data = public_resp.json()
        assert data["node"]["uuid"] == page["uuid"]
        assert "children" in data


class TestPublicShareStaticHtml:
    """Test static HTML generation, serving, regeneration, and cleanup."""

    @pytest.mark.asyncio
    async def test_static_html_file_generated_on_share_create(
        self,
        authenticated_client: AsyncClient,
        temp_data_dir,
    ):
        """Creating a public share should generate a static HTML file."""
        create_resp = await authenticated_client.post("/api/nodes/page", params={"name": "Shareable Page"})
        assert create_resp.status_code == 200
        page = create_resp.json()
        page_id = page["id"]

        share_resp = await authenticated_client.post(f"/api/nodes/{page_id}/shares", json={})
        assert share_resp.status_code == 200
        share_uuid = share_resp.json()["share_uuid"]

        html_path = get_static_share_path(share_uuid)
        assert html_path.exists(), f"Expected static HTML at {html_path}"
        assert html_path.stat().st_size > 0

    @pytest.mark.asyncio
    async def test_static_html_served_at_s_endpoint(
        self,
        authenticated_client: AsyncClient,
        client: AsyncClient,
    ):
        """GET /s/{share_uuid} should serve the pre-generated static HTML."""
        create_resp = await authenticated_client.post("/api/nodes/page", params={"name": "Served Page"})
        assert create_resp.status_code == 200
        page_id = create_resp.json()["id"]

        share_resp = await authenticated_client.post(f"/api/nodes/{page_id}/shares", json={})
        assert share_resp.status_code == 200
        share_uuid = share_resp.json()["share_uuid"]

        resp = await client.get(f"/s/{share_uuid}")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/html")
        assert "Served Page" in resp.text or "<!DOCTYPE html>" in resp.text.upper()

    @pytest.mark.asyncio
    async def test_static_html_regenerated_on_page_update(
        self,
        authenticated_client: AsyncClient,
        temp_data_dir,
    ):
        """Updating page content should regenerate the static HTML file."""
        create_resp = await authenticated_client.post("/api/nodes/page", params={"name": "Original Content"})
        assert create_resp.status_code == 200
        page = create_resp.json()
        page_id = page["id"]

        share_resp = await authenticated_client.post(f"/api/nodes/{page_id}/shares", json={})
        assert share_resp.status_code == 200
        share_uuid = share_resp.json()["share_uuid"]

        html_path = get_static_share_path(share_uuid)
        initial_content = html_path.read_text(encoding="utf-8")
        assert "Original Content" in initial_content

        # Update the page content
        update_resp = await authenticated_client.put(
            f"/api/nodes/{page_id}", json={"name": "Updated Content"}
        )
        assert update_resp.status_code == 200

        # Verify the HTML file was regenerated
        updated_content = html_path.read_text(encoding="utf-8")
        assert "Updated Content" in updated_content
        assert updated_content != initial_content

    @pytest.mark.asyncio
    async def test_static_html_removed_on_share_delete(
        self,
        authenticated_client: AsyncClient,
        temp_data_dir,
    ):
        """Deleting a share should remove the static HTML file."""
        create_resp = await authenticated_client.post("/api/nodes/page", params={"name": "Removable Page"})
        assert create_resp.status_code == 200
        page_id = create_resp.json()["id"]

        share_resp = await authenticated_client.post(f"/api/nodes/{page_id}/shares", json={})
        assert share_resp.status_code == 200
        share_uuid = share_resp.json()["share_uuid"]

        html_path = get_static_share_path(share_uuid)
        assert html_path.exists()

        # Delete the share via the workspace-level shares endpoint
        delete_resp = await authenticated_client.delete(f"/api/shares/{share_uuid}")
        assert delete_resp.status_code == 200

        assert not html_path.exists(), f"Expected static HTML to be removed: {html_path}"


class TestPermissionCheckerPrivacy:
    """Test PermissionChecker privacy logic directly."""

    @pytest.mark.asyncio
    async def test_private_page_returns_none_for_non_owners(
        self,
        db_pool,
        test_user: dict,
        node_service,
    ):
        """PermissionChecker should return Permissions.none() for private pages when caller is not the owner."""
        # Create a page as the test_user (owner)
        page = await node_service.create_page("Private Permission Page")
        assert page.id is not None

        # Set page to private via repository to bypass permission checks on update
        await node_service._node_repo.update(page.id, NodeUpdateData(is_private=True))

        # Create a PermissionChecker for a different user
        other_user = await auth.create_user("permission_checker@example.com", "password123")
        permission_repo = PostgresPermissionRepository(
            db_pool, test_user["workspace_id"], int(other_user["id"])
        )
        checker = PermissionChecker(int(other_user["id"]), permission_repo)

        perms = await checker.get_node_permissions(page.id)
        assert perms == Permissions.none()
        assert not perms.can_read
        assert not perms.can_write
        assert not perms.can_create
        assert not perms.can_delete

    @pytest.mark.asyncio
    async def test_workspace_page_returns_workspace_permissions_for_non_owners(
        self,
        db_pool,
        test_user: dict,
        node_service,
    ):
        """PermissionChecker should fall back to workspace permissions for workspace-visible pages."""
        page = await node_service.create_page("Workspace Permission Page")
        assert page.id is not None

        await node_service._node_repo.update(page.id, NodeUpdateData(is_private=False))

        # Create a user who has workspace read access
        other_user = await auth.create_user("workspace_reader@example.com", "password123")
        async with db_pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO workspace_share
                    (workspace_id, user_id, can_read, can_write, can_create, can_delete, active, create_uid)
                VALUES ($1, $2, TRUE, FALSE, FALSE, FALSE, TRUE, $3)
                ON CONFLICT (workspace_id, user_id) DO NOTHING
                """,
                test_user["workspace_id"],
                int(other_user["id"]),
                int(test_user["id"]),
            )

        permission_repo = PostgresPermissionRepository(
            db_pool, test_user["workspace_id"], int(other_user["id"])
        )
        checker = PermissionChecker(int(other_user["id"]), permission_repo)
        perms = await checker.get_node_permissions(page.id)
        assert perms.can_read is True
        assert perms.can_write is False

    @pytest.mark.asyncio
    async def test_owner_always_has_full_permissions(
        self,
        db_pool,
        test_user: dict,
        node_service,
    ):
        """The owner should have full permissions regardless of privacy."""
        page = await node_service.create_page("Owner Permission Page")
        assert page.id is not None

        await node_service._node_repo.update(page.id, NodeUpdateData(is_private=True))

        permission_repo = PostgresPermissionRepository(
            db_pool, test_user["workspace_id"], int(test_user["id"])
        )
        checker = PermissionChecker(int(test_user["id"]), permission_repo)
        perms = await checker.get_node_permissions(page.id)
        assert perms == Permissions.owner()
        assert perms.can_read
        assert perms.can_write
        assert perms.can_create
        assert perms.can_delete
