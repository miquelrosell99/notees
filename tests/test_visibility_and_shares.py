"""Tests for public share static HTML and PermissionChecker privacy logic.

These tests verify:
1. Public share static HTML files are generated, served, regenerated, and cleaned up
2. PermissionChecker returns correct permissions based on is_private

Page privacy enforcement through the deleted ``/api/nodes/{uuid}`` REST endpoints
is covered by ``TestPermissionCheckerPrivacy`` and relay permission tests, so the
legacy ``TestPagePrivacy`` class has been removed.
"""

from datetime import UTC, datetime

import pytest
from httpx import AsyncClient

from app.core.workspace_store import WorkspaceStore
from app.domain.permissions import PermissionChecker, Permissions
from app.domain.repositories import PostgresPermissionRepository
from app.features.auth import auth
from app.features.export.dependencies import _get_export_renderer
from app.features.export.repository import PostgresExportRepository
from app.features.export.service import ExportService
from app.features.shares.dependencies import _get_share_service
from app.features.shares.repository import PostgresShareRepository
from app.features.shares.service import ShareService
from app.infrastructure.export.share_files import get_static_share_path
from app.models import User


def _ast_name(text: str) -> str:
    """Return a JSON AST representation of a plain-text node name.

    The export renderer expects node names as AST documents; plain text is
    treated as an empty document and would not appear in generated HTML.
    """
    import json

    return json.dumps([{"type": "paragraph", "children": [{"type": "text", "text": text}]}])


async def _create_test_node(
    conn, workspace_id: int, owner_id: int, *, name: str, is_page: bool = True, is_private: bool = False
) -> str:
    """Insert a node row directly and return its UUID."""
    row = await conn.fetchrow(
        """
        INSERT INTO node (uuid, workspace_id, name, is_page, active, is_private, create_uid, write_uid)
        VALUES (uuid_generate_v4(), $1, $2, $3, TRUE, $4, $5, $5)
        RETURNING uuid
        """,
        workspace_id,
        _ast_name(name),
        is_page,
        is_private,
        owner_id,
    )
    return str(row["uuid"])


async def _create_page_node(db_pool, test_user: dict, name: str) -> str:
    """Insert a page row into PostgreSQL and mirror it in the derived store."""
    async with db_pool.acquire() as conn:
        page_uuid = await _create_test_node(conn, test_user["workspace_id"], int(test_user["id"]), name=name)

    store = WorkspaceStore(
        workspace_id=test_user["workspace_uuid"],
        actor_id=test_user["uuid"],
    )
    try:
        await store.create_node(page_uuid, kind="page")
    finally:
        await store.close()
    return page_uuid


@pytest.fixture
async def share_service(db_pool, test_user: dict) -> ShareService:
    """Build a ShareService wired to the test user's workspace."""
    workspace_id = test_user["workspace_id"]
    user_id = int(test_user["id"])
    share_repo = PostgresShareRepository(db_pool, workspace_id, user_id)
    export_repo = PostgresExportRepository(db_pool, workspace_id)
    export_service = ExportService(export_repo, _get_export_renderer())
    return ShareService(share_repo, export_service, workspace_id, user_id)


@pytest.mark.integration
class TestPublicShareStaticHtml:
    """Test static HTML generation, serving, regeneration, and cleanup."""

    @pytest.mark.asyncio
    async def test_static_html_file_generated_on_share_create(
        self,
        authenticated_client: AsyncClient,
        db_pool,
        test_user: dict,
        temp_data_dir,
    ):
        """Creating a public share should generate a static HTML file."""
        page_uuid = await _create_page_node(db_pool, test_user, "Shareable Page")

        share_resp = await authenticated_client.post(f"/api/nodes/{page_uuid}/shares", json={})
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
        db_pool,
        test_user: dict,
    ):
        """GET /s/{share_uuid} should serve the pre-generated static HTML."""
        page_uuid = await _create_page_node(db_pool, test_user, "Served Page")

        share_resp = await authenticated_client.post(f"/api/nodes/{page_uuid}/shares", json={})
        assert share_resp.status_code == 200
        share_uuid = share_resp.json()["share_uuid"]

        resp = await client.get(f"/s/{share_uuid}")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/html")
        assert "Served Page" in resp.text or "<!DOCTYPE html>" in resp.text.lower()

    @pytest.mark.asyncio
    async def test_static_html_regenerated_on_page_update(
        self,
        authenticated_client: AsyncClient,
        db_pool,
        test_user: dict,
        temp_data_dir,
    ):
        """Updating page content should regenerate the static HTML file."""
        page_uuid = await _create_page_node(db_pool, test_user, "Original Content")

        share_resp = await authenticated_client.post(f"/api/nodes/{page_uuid}/shares", json={})
        assert share_resp.status_code == 200
        share_uuid = share_resp.json()["share_uuid"]

        html_path = get_static_share_path(share_uuid)
        initial_content = html_path.read_text(encoding="utf-8")
        assert "Original Content" in initial_content

        # Update the page content directly in PostgreSQL.
        async with db_pool.acquire() as conn:
            await conn.execute(
                "UPDATE node SET name = $1 WHERE uuid = $2",
                _ast_name("Updated Content"),
                page_uuid,
            )

        # Regenerate the HTML file using the share service.
        user = User(
            id=str(test_user["id"]),
            uuid=test_user["uuid"],
            email=test_user["email"],
            created_at=datetime.now(UTC),
        )
        share_service = await _get_share_service(user)
        await share_service.regenerate_share_html_for_node(page_uuid)

        # Verify the HTML file was regenerated.
        updated_content = html_path.read_text(encoding="utf-8")
        assert "Updated Content" in updated_content
        assert updated_content != initial_content

    @pytest.mark.asyncio
    async def test_static_html_removed_on_share_delete(
        self,
        authenticated_client: AsyncClient,
        db_pool,
        test_user: dict,
        temp_data_dir,
    ):
        """Deleting a share should remove the static HTML file."""
        page_uuid = await _create_page_node(db_pool, test_user, "Removable Page")

        share_resp = await authenticated_client.post(f"/api/nodes/{page_uuid}/shares", json={})
        assert share_resp.status_code == 200
        share_uuid = share_resp.json()["share_uuid"]

        html_path = get_static_share_path(share_uuid)
        assert html_path.exists()

        # Delete the share via the workspace-level shares endpoint.
        delete_resp = await authenticated_client.delete(f"/api/shares/{share_uuid}")
        assert delete_resp.status_code == 200

        assert not html_path.exists(), f"Expected static HTML to be removed: {html_path}"


class TestPermissionCheckerPrivacy:
    """Test PermissionChecker privacy logic directly using raw DB rows."""

    async def _create_test_node(
        self,
        conn,
        workspace_id: int,
        owner_id: int,
        *,
        name: str = "Test Page",
        is_private: bool = False,
    ) -> str:
        """Insert a node row and return its UUID."""
        row = await conn.fetchrow(
            """
            INSERT INTO node (uuid, workspace_id, name, is_page, active, is_private, create_uid, write_uid)
            VALUES (uuid_generate_v4(), $1, $2, TRUE, TRUE, $3, $4, $4)
            RETURNING uuid
            """,
            workspace_id,
            name,
            is_private,
            owner_id,
        )
        return str(row["uuid"])

    @pytest.mark.asyncio
    async def test_private_page_returns_none_for_non_owners(
        self,
        db_pool,
        test_user: dict,
    ):
        """PermissionChecker should return Permissions.none() for private pages when caller is not the owner."""
        other_user = await auth.create_user("permission_checker@example.com", "password123")
        async with db_pool.acquire() as conn:
            page_uuid = await self._create_test_node(
                conn,
                test_user["workspace_id"],
                int(test_user["id"]),
                name="Private Permission Page",
                is_private=True,
            )

        permission_repo = PostgresPermissionRepository(db_pool, test_user["workspace_id"], int(other_user["id"]))
        checker = PermissionChecker(int(other_user["id"]), permission_repo)

        perms = await checker.get_node_permissions(page_uuid)
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
    ):
        """PermissionChecker should fall back to workspace permissions for workspace-visible pages."""
        other_user = await auth.create_user("workspace_reader@example.com", "password123")
        async with db_pool.acquire() as conn:
            page_uuid = await self._create_test_node(
                conn,
                test_user["workspace_id"],
                int(test_user["id"]),
                name="Workspace Permission Page",
                is_private=False,
            )
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

        permission_repo = PostgresPermissionRepository(db_pool, test_user["workspace_id"], int(other_user["id"]))
        checker = PermissionChecker(int(other_user["id"]), permission_repo)
        perms = await checker.get_node_permissions(page_uuid)
        assert perms.can_read is True
        assert perms.can_write is False

    @pytest.mark.asyncio
    async def test_owner_always_has_full_permissions(
        self,
        db_pool,
        test_user: dict,
    ):
        """The owner should have full permissions regardless of privacy."""
        async with db_pool.acquire() as conn:
            page_uuid = await self._create_test_node(
                conn,
                test_user["workspace_id"],
                int(test_user["id"]),
                name="Owner Permission Page",
                is_private=True,
            )

        permission_repo = PostgresPermissionRepository(db_pool, test_user["workspace_id"], int(test_user["id"]))
        checker = PermissionChecker(int(test_user["id"]), permission_repo)
        perms = await checker.get_node_permissions(page_uuid)
        assert perms == Permissions.owner()
        assert perms.can_read
        assert perms.can_write
        assert perms.can_create
        assert perms.can_delete
