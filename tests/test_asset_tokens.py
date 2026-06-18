"""Tests for asset token authentication on asset download endpoints."""

from io import BytesIO

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_asset_download_rejects_invalid_uuid(authenticated_client: AsyncClient):
    """Downloading an asset with a malformed UUID must be rejected."""
    response = await authenticated_client.get("/api/assets/not-a-uuid")
    assert response.status_code in (403, 404)


@pytest.mark.asyncio
async def test_asset_thumbnail_rejects_invalid_uuid(authenticated_client: AsyncClient):
    """Downloading a thumbnail with a malformed UUID must be rejected."""
    response = await authenticated_client.get("/api/assets/not-a-uuid/thumbnail")
    assert response.status_code in (403, 404)


@pytest.mark.asyncio
async def test_asset_token_allows_download_without_auth_header(authenticated_client: AsyncClient):
    """An asset downloaded with a valid asset_token should not need a JWT header."""
    # Upload a small image asset.
    file_content = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"fake-jpeg-data"
    response = await authenticated_client.post(
        "/api/assets/upload",
        files={"file": ("test.jpg", BytesIO(file_content), "image/jpeg")},
    )
    assert response.status_code == 200, response.text
    asset_uuid = response.json()["uuid"]

    # Generate a token for the asset.
    token_response = await authenticated_client.post(f"/api/assets/{asset_uuid}/token")
    assert token_response.status_code == 200, token_response.text
    asset_token = token_response.json()["token"]

    # Download using only the asset_token query parameter, without Authorization.
    download_response = await authenticated_client.get(
        f"/api/assets/{asset_uuid}",
        params={"asset_token": asset_token},
        headers={"Authorization": ""},  # explicitly clear any default auth header
    )
    assert download_response.status_code == 200, download_response.text
    assert download_response.content == file_content


@pytest.mark.asyncio
async def test_asset_download_without_token_or_auth_fails(authenticated_client: AsyncClient):
    """Downloading an asset with neither JWT nor asset_token should 401."""
    file_content = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"fake-jpeg-data"
    response = await authenticated_client.post(
        "/api/assets/upload",
        files={"file": ("test.jpg", BytesIO(file_content), "image/jpeg")},
    )
    assert response.status_code == 200, response.text
    asset_uuid = response.json()["uuid"]

    download_response = await authenticated_client.get(
        f"/api/assets/{asset_uuid}",
        headers={"Authorization": ""},
    )
    assert download_response.status_code == 401


@pytest.mark.asyncio
async def test_asset_download_with_invalid_token_fails(authenticated_client: AsyncClient):
    """Downloading an asset with an invalid asset_token should 401."""
    file_content = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"fake-jpeg-data"
    response = await authenticated_client.post(
        "/api/assets/upload",
        files={"file": ("test.jpg", BytesIO(file_content), "image/jpeg")},
    )
    assert response.status_code == 200, response.text
    asset_uuid = response.json()["uuid"]

    download_response = await authenticated_client.get(
        f"/api/assets/{asset_uuid}",
        params={"asset_token": "invalid-token"},
        headers={"Authorization": ""},
    )
    assert download_response.status_code == 401


@pytest.mark.asyncio
async def test_asset_thumbnail_with_token_allows_download_without_auth_header(
    authenticated_client: AsyncClient,
):
    """An asset thumbnail downloaded with a valid asset_token should not need a JWT header."""
    file_content = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"fake-jpeg-data"
    response = await authenticated_client.post(
        "/api/assets/upload",
        files={"file": ("test.jpg", BytesIO(file_content), "image/jpeg")},
    )
    assert response.status_code == 200, response.text
    asset_uuid = response.json()["uuid"]

    token_response = await authenticated_client.post(f"/api/assets/{asset_uuid}/token")
    assert token_response.status_code == 200, token_response.text
    asset_token = token_response.json()["token"]

    download_response = await authenticated_client.get(
        f"/api/assets/{asset_uuid}/thumbnail",
        params={"asset_token": asset_token},
        headers={"Authorization": ""},
    )
    # Thumbnail may be 200 if generated, or 404 if not; either is acceptable
    # as long as auth did not reject it with 401.
    assert download_response.status_code in (200, 404)
