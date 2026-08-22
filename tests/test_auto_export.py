"""Tests for the auto-export endpoints."""
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
async def test_auto_export_download_not_found(authenticated_client, test_user):
    """Test download returns 404 when no exported files exist."""
    response = await authenticated_client.get("/api/auto-export/download")
    assert response.status_code == 404
