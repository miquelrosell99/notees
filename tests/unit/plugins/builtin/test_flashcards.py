"""Unit tests for the flashcards plugin repository/service layer."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.db import schema
from app.domain.entities import generate_uuid
from app.plugins.builtin.flashcards.repository import PostgresFlashcardRepository
from app.plugins.builtin.flashcards.service import FlashcardService


@pytest.mark.unit
@pytest.mark.asyncio
async def test_create_flashcard(db_pool, test_user):
    """Creating a flashcard stores it against the supplied node UUID."""
    repo = PostgresFlashcardRepository(test_user["workspace_id"])
    service = FlashcardService(
        repo, test_user["workspace_id"], int(test_user["id"])
    )
    node_uuid = generate_uuid()

    card = await service.create_flashcard(node_uuid, "front", "back")

    assert card.node_uuid == node_uuid
    assert card.front_text == "front"
    assert card.back_text == "back"
    assert card.workspace_id == test_user["workspace_id"]
    assert card.user_id == int(test_user["id"])
    assert card.ease_factor == 2.5
    assert card.interval_days == 0
    assert card.repetitions == 0
    assert card.active is True


@pytest.mark.unit
@pytest.mark.asyncio
async def test_upsert_flashcard_updates_text(db_pool, test_user):
    """Inserting the same node UUID twice upserts front/back text."""
    repo = PostgresFlashcardRepository(test_user["workspace_id"])
    service = FlashcardService(
        repo, test_user["workspace_id"], int(test_user["id"])
    )
    node_uuid = generate_uuid()

    await service.create_flashcard(node_uuid, "old front", "old back")
    updated = await service.create_flashcard(node_uuid, "new front", "new back")

    assert updated.id == (await service.get_by_node_uuid(node_uuid)).id
    assert updated.front_text == "new front"
    assert updated.back_text == "new back"
    assert updated.active is True


@pytest.mark.unit
@pytest.mark.asyncio
async def test_get_flashcard_by_node_uuid(db_pool, test_user):
    """A stored flashcard can be fetched by its node UUID."""
    repo = PostgresFlashcardRepository(test_user["workspace_id"])
    service = FlashcardService(
        repo, test_user["workspace_id"], int(test_user["id"])
    )
    node_uuid = generate_uuid()

    created = await service.create_flashcard(node_uuid, "q", "a")
    fetched = await service.get_by_node_uuid(node_uuid)

    assert fetched is not None
    assert fetched.uuid == created.uuid
    assert fetched.node_uuid == node_uuid


@pytest.mark.unit
@pytest.mark.asyncio
async def test_get_flashcard_by_node_uuid_missing(db_pool, test_user):
    """Fetching an unknown node UUID returns None."""
    repo = PostgresFlashcardRepository(test_user["workspace_id"])
    service = FlashcardService(
        repo, test_user["workspace_id"], int(test_user["id"])
    )

    assert await service.get_by_node_uuid(generate_uuid()) is None


@pytest.mark.unit
@pytest.mark.asyncio
async def test_review_flashcard_updates_srs(db_pool, test_user):
    """Reviewing a card updates ease, interval, repetitions, lapses and due date."""
    repo = PostgresFlashcardRepository(test_user["workspace_id"])
    service = FlashcardService(
        repo, test_user["workspace_id"], int(test_user["id"])
    )
    node_uuid = generate_uuid()
    await service.create_flashcard(node_uuid, "q", "a")

    reviewed = await service.review_card(node_uuid, grade=5)

    assert reviewed.repetitions == 1
    assert reviewed.interval_days == 1
    assert reviewed.lapses == 0
    assert reviewed.ease_factor > 2.5
    assert reviewed.due_date is not None
    assert reviewed.last_reviewed_at is not None
    assert reviewed.due_date > datetime.now(UTC) - timedelta(minutes=1)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_get_due_cards_respects_workspace_and_ordering(db_pool, test_user):
    """Due cards are scoped to workspace/user and ordered nulls-first then by date."""
    # Create a second workspace for the same user so we can verify scoping.
    async with db_pool.acquire() as conn:
        other_workspace_id = await schema.create_workspace_for_user(
            conn, int(test_user["id"]), name="Other"
        )

    repo = PostgresFlashcardRepository(test_user["workspace_id"])
    service = FlashcardService(
        repo, test_user["workspace_id"], int(test_user["id"])
    )
    other_repo = PostgresFlashcardRepository(other_workspace_id)
    other_service = FlashcardService(
        other_repo, other_workspace_id, int(test_user["id"])
    )

    now = datetime.now(UTC)
    ws_node_new = generate_uuid()
    ws_node_due = generate_uuid()
    other_node = generate_uuid()

    await service.create_flashcard(ws_node_new, "new", "new")
    await service.create_flashcard(ws_node_due, "due", "due")
    # Manually set the second card to a past due date so it sorts after the new card.
    await repo.update_srs(
        ws_node_due,
        ease_factor=2.5,
        interval_days=1,
        repetitions=1,
        lapses=0,
        due_date=now - timedelta(days=1),
        last_reviewed_at=now,
    )
    await other_service.create_flashcard(other_node, "other", "other")

    due = await service.get_due_cards(limit=10)
    due_node_uuids = [c.node_uuid for c in due]

    assert ws_node_new in due_node_uuids
    assert ws_node_due in due_node_uuids
    assert other_node not in due_node_uuids
    # New (NULL due_date) card should come before the overdue card.
    assert due_node_uuids.index(ws_node_new) < due_node_uuids.index(ws_node_due)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_get_stats_returns_counts(db_pool, test_user):
    """Stats aggregate total, due, new and mature cards for the workspace."""
    repo = PostgresFlashcardRepository(test_user["workspace_id"])
    service = FlashcardService(
        repo, test_user["workspace_id"], int(test_user["id"])
    )

    now = datetime.now(UTC)
    new_card = generate_uuid()
    mature_card = generate_uuid()
    inactive_card = generate_uuid()

    await service.create_flashcard(new_card, "new", "new")
    await service.create_flashcard(mature_card, "mature", "mature")
    await repo.update_srs(
        mature_card,
        ease_factor=2.5,
        interval_days=21,
        repetitions=3,
        lapses=0,
        due_date=now - timedelta(days=1),
        last_reviewed_at=now,
    )
    # Inactive cards count toward total/new/mature but not due_now.
    await service.create_flashcard(inactive_card, "inactive", "inactive")
    from app.db.connection import get_connection

    async with get_connection() as conn:
        await conn.execute(
            "UPDATE flashcard SET active = FALSE WHERE node_uuid = $1",
            inactive_card,
        )

    stats = await service.get_stats()

    assert stats["total_cards"] == 3
    assert stats["due_now"] == 2  # new + mature (inactive is excluded)
    assert stats["new_cards"] == 2  # new + inactive
    assert stats["mature_cards"] == 1
