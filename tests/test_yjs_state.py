"""Tests for the legacy Postgres Yjs CRDT repository.

The HTTP endpoints have been ported to WorkspaceStore in Phase 7; their
behavior is covered by ``tests/core/test_collab_router.py``.
"""

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
