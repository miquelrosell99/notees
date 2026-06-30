"""Tests for Yjs CRDT state persistence and endpoints."""

from __future__ import annotations

import pytest

from app.domain.entities import NodeCreateData
from app.features.collab.yjs_repository import PostgresYjsRepository


@pytest.fixture
def yjs_repository(db_pool, test_user) -> PostgresYjsRepository:
    """Create a Yjs repository for the test user's workspace."""
    return PostgresYjsRepository(
        db_pool, test_user["workspace_id"], int(test_user["id"])
    )


@pytest.fixture
async def test_page(node_repository, test_user):
    """Create a simple page node and return its UUID."""
    node = await node_repository.create(
        NodeCreateData(name="Yjs test page", is_page=True),
        user_id=int(test_user["id"]),
    )
    return node.uuid


@pytest.mark.asyncio
async def test_get_state_returns_none_for_new_node(yjs_repository, test_page):
    """A node with no Yjs state returns None."""
    state = await yjs_repository.get_state(test_page)
    assert state is None


@pytest.mark.asyncio
async def test_apply_update_stores_blob(yjs_repository, test_page):
    """Applying a single Yjs update stores the blob."""
    update = b"\x00\x01\x02fake-yjs-update"
    await yjs_repository.apply_update(test_page, update)

    state = await yjs_repository.get_state(test_page)
    assert state == update


@pytest.mark.asyncio
async def test_apply_update_merges_blob(yjs_repository, test_page):
    """Applying multiple updates concatenates them into the stored blob."""
    first = b"\x00\x01first"
    second = b"\x02\x03second"

    await yjs_repository.apply_update(test_page, first)
    merged = await yjs_repository.apply_update(test_page, second)

    assert merged == first + second
    assert await yjs_repository.get_state(test_page) == first + second


@pytest.mark.asyncio
async def test_http_get_state_empty_for_new_node(authenticated_client, test_page):
    """GET /nodes/{uuid}/yjs_state returns empty bytes when no state exists."""
    response = await authenticated_client.get(f"/api/nodes/{test_page}/yjs_state")
    assert response.status_code == 200
    assert response.content == b""


@pytest.mark.asyncio
async def test_http_post_update_and_get_state(authenticated_client, test_page):
    """POST applies an update and GET returns the merged blob."""
    update = b"\xaa\xbb\xccyjs-update-via-http"

    post_response = await authenticated_client.post(
        f"/api/nodes/{test_page}/yjs_update",
        content=update,
    )
    assert post_response.status_code == 200
    assert post_response.json()["status"] == "ok"

    get_response = await authenticated_client.get(f"/api/nodes/{test_page}/yjs_state")
    assert get_response.status_code == 200
    assert get_response.content == update


@pytest.mark.asyncio
async def test_http_post_multiple_updates_merge(authenticated_client, test_page):
    """Multiple POSTs concatenate updates."""
    first = b"\x01first-http"
    second = b"\x02second-http"

    await authenticated_client.post(
        f"/api/nodes/{test_page}/yjs_update", content=first
    )
    await authenticated_client.post(
        f"/api/nodes/{test_page}/yjs_update", content=second
    )

    response = await authenticated_client.get(f"/api/nodes/{test_page}/yjs_state")
    assert response.content == first + second
