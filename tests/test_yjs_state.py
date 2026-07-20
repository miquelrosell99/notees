"""Tests for the Postgres Yjs CRDT repository."""

from __future__ import annotations

import uuid

import pytest

from app.features.collab.yjs_repository import PostgresYjsRepository


@pytest.fixture
def yjs_repository(db_pool, test_user) -> PostgresYjsRepository:
    """Create a Yjs repository for the test user's workspace."""
    return PostgresYjsRepository(db_pool, test_user["workspace_id"], int(test_user["id"]))


@pytest.fixture
async def test_page(db_pool, test_user):
    """Create a simple page node directly in the DB and return its UUID."""
    page_uuid = str(uuid.uuid4())
    async with db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO node (uuid, workspace_id, name, is_page, active)
            VALUES ($1, $2, $3, TRUE, TRUE)
            """,
            page_uuid,
            test_user["workspace_id"],
            "Yjs test page",
        )
    return page_uuid


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
