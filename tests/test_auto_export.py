import io
import zipfile

import pytest


@pytest.mark.asyncio
async def test_auto_export_batch_starts(authenticated_client, test_user):
    """Test batch auto-export endpoint starts successfully."""
    response = await authenticated_client.post("/api/auto-export/batch", json={})
    assert response.status_code == 200
    data = response.json()
    assert data.get("status") == "started"

    # Status endpoint should report progress (may still be running or done)
    status_response = await authenticated_client.get("/api/auto-export/status")
    assert status_response.status_code == 200
    status = status_response.json()
    assert "running" in status
    assert "total" in status
    assert "completed" in status


@pytest.mark.asyncio
async def test_auto_export_single_page_not_found(authenticated_client, test_user):
    """Test single page auto-export returns 404 for non-existent page."""
    response = await authenticated_client.post("/api/auto-export/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_auto_export_empty_page(authenticated_client, test_user):
    """Test auto-export succeeds for a page with no child blocks."""
    response = await authenticated_client.post("/api/nodes/page?name=Empty%20Page")
    assert response.status_code == 200
    page = response.json()
    page_uuid = page["uuid"]

    export_response = await authenticated_client.post(f"/api/auto-export/{page_uuid}")
    assert export_response.status_code == 200
    data = export_response.json()
    assert data["filename"] == f"{page_uuid}.md"

    download_response = await authenticated_client.get("/api/auto-export/download")
    assert download_response.status_code == 200
    assert download_response.headers.get("content-type") == "application/zip"


@pytest.mark.asyncio
async def test_auto_export_download_not_found(authenticated_client, test_user):
    """Test download returns 404 when no exported files exist."""
    response = await authenticated_client.get("/api/auto-export/download")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_auto_export_download_zip(authenticated_client, test_user):
    """Test downloading exported markdown files as a ZIP."""
    # Create a page first
    response = await authenticated_client.post("/api/nodes/", json={"name": "Test Page"})
    assert response.status_code == 200
    page = response.json()
    page_uuid = page["uuid"]

    # Export the page
    export_response = await authenticated_client.post(f"/api/auto-export/{page_uuid}")
    assert export_response.status_code == 200

    # Download the ZIP
    download_response = await authenticated_client.get("/api/auto-export/download")
    assert download_response.status_code == 200
    assert download_response.headers.get("content-type") == "application/zip"
    disposition = download_response.headers.get("content-disposition", "")
    assert "attachment" in disposition
    assert ".zip" in disposition

    # Verify it's a valid ZIP containing the markdown file
    content = download_response.content
    zip_file = zipfile.ZipFile(io.BytesIO(content))
    names = zip_file.namelist()
    assert any(name.endswith(".md") for name in names)
