"""Unit tests for the flashcards plugin repository/service layer."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio

from app.db import schema
from app.db.connection import get_connection
from app.domain.entities import generate_uuid
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS
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


@pytest.mark.unit
@pytest.mark.asyncio
async def test_hydrate_flashcard_from_node_content(db_pool, test_user):
    """Stored front/back are overridden with live node content on read."""
    from app.core.workspace_store import WorkspaceStore
    from app.domain.entities import generate_uuid
    from app.domain.entities.constants import SYSTEM_CLASS_UUIDS

    workspace_uuid = test_user["workspace_uuid"]
    actor_uuid = test_user["uuid"]
    store = WorkspaceStore(workspace_uuid, actor_uuid)

    card_uuid = generate_uuid()
    cloze1_uuid = generate_uuid()
    cloze2_uuid = generate_uuid()

    try:
        await store.create_node(
            node_id=card_uuid,
            kind="block",
            initial_content=[
                {
                    "type": "paragraph",
                    "children": [{"text": "Front text"}],
                }
            ],
        )
        await store.create_node(
            node_id=cloze1_uuid,
            kind="block",
            parent_id=card_uuid,
            index=0,
            initial_content=[
                {
                    "type": "paragraph",
                    "children": [{"text": "Cloze one"}],
                }
            ],
            class_ids=[SYSTEM_CLASS_UUIDS["cloze"]],
        )
        await store.create_node(
            node_id=cloze2_uuid,
            kind="block",
            parent_id=card_uuid,
            index=1,
            initial_content=[
                {
                    "type": "paragraph",
                    "children": [{"text": "Cloze two"}],
                }
            ],
            class_ids=[SYSTEM_CLASS_UUIDS["cloze"]],
        )

        repo = PostgresFlashcardRepository(test_user["workspace_id"])
        service = FlashcardService(
            repo, test_user["workspace_id"], int(test_user["id"]), store
        )

        await service.create_flashcard(card_uuid, "old front", "old back")
        card = await service.get_by_node_uuid(card_uuid)

        assert card is not None
        assert card.front_text == "Front text"
        assert card.back_text == "Cloze one\n\n---\n\nCloze two"
    finally:
        await store.close()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_hydrate_fallback_when_node_missing(db_pool, test_user):
    """When the card node is not in derived state, stored values are preserved."""
    repo = PostgresFlashcardRepository(test_user["workspace_id"])
    service = FlashcardService(
        repo, test_user["workspace_id"], int(test_user["id"]), store=None
    )
    node_uuid = generate_uuid()

    await service.create_flashcard(node_uuid, "stored front", "stored back")
    card = await service.get_by_node_uuid(node_uuid)

    assert card is not None
    assert card.front_text == "stored front"
    assert card.back_text == "stored back"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_auto_create_flashcard_side_effect_handler(db_pool, test_user):
    """The card-class side-effect handler upserts a flashcard row."""
    from app.plugins.builtin.flashcards.setup import _on_card_class_changed
    from app.plugins.core.context import PluginContext
    from app.plugins.core.ports import ClassSideEffectContext
    from app.plugins.core.registry import PluginRegistry

    registry = PluginRegistry()
    context = PluginContext(
        plugin_id="notees.flashcards",
        permissions={"read_nodes", "write_nodes", "router"},
        registry=registry,
        port_factories={},
    )

    node_uuid = generate_uuid()
    await _on_card_class_changed(
        ClassSideEffectContext(
            node_uuid=node_uuid,
            class_uuid=SYSTEM_CLASS_UUIDS["card"],
            workspace_uuid=test_user["workspace_uuid"],
            actor_uuid=test_user["uuid"],
            plugin_context=context,
            added=True,
            removed=False,
        )
    )

    async with get_connection() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM flashcard WHERE node_uuid = $1", node_uuid
        )

    assert row is not None
    assert str(row["node_uuid"]) == node_uuid
    assert row["workspace_id"] == test_user["workspace_id"]
    assert row["user_id"] == int(test_user["id"])
    assert row["front_text"] == ""
    assert row["back_text"] == ""


@pytest.mark.unit
@pytest.mark.asyncio
async def test_auto_create_flashcard_on_class_assign(db_pool, test_user):
    """Assigning the card class via WorkspaceStore creates a flashcard record."""
    from app.core.derived.class_side_effects import clear as clear_class_side_effects
    from app.core.workspace_store import WorkspaceStore
    from app.plugins.builtin.flashcards.setup import setup as flashcards_setup
    from app.plugins.core.context import PluginContext
    from app.plugins.core.registry import PluginRegistry

    clear_class_side_effects()
    registry = PluginRegistry()
    context = PluginContext(
        plugin_id="notees.flashcards",
        permissions={"read_nodes", "write_nodes", "router"},
        registry=registry,
        port_factories={},
    )
    await flashcards_setup(context)

    workspace_uuid = test_user["workspace_uuid"]
    actor_uuid = test_user["uuid"]
    store = WorkspaceStore(workspace_uuid, actor_uuid)

    node_uuid = generate_uuid()
    try:
        await store.create_node(
            node_id=node_uuid,
            kind="block",
            initial_content=[
                {
                    "type": "paragraph",
                    "children": [{"text": "Auto card"}],
                }
            ],
        )
        await store.assign_class(node_uuid, SYSTEM_CLASS_UUIDS["card"])

        async with get_connection() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM flashcard WHERE node_uuid = $1", node_uuid
            )

        assert row is not None
        assert str(row["node_uuid"]) == node_uuid
        assert row["workspace_id"] == test_user["workspace_id"]
        assert row["user_id"] == int(test_user["id"])
    finally:
        await store.close()
        clear_class_side_effects()


@pytest_asyncio.fixture
async def flashcards_client(db_pool, test_user):
    """Authenticated test client with flashcard dependencies overridden."""
    from collections.abc import AsyncGenerator

    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from app.core.workspace_store import WorkspaceStore
    from app.dependencies import get_current_user, get_workspace_id
    from app.models import User
    from app.plugins.builtin.flashcards.dependencies import (
        get_flashcard_service,
        get_workspace_store,
    )
    from app.plugins.builtin.flashcards.router import router as flashcards_router

    workspace_uuid = test_user["workspace_uuid"]
    actor_uuid = test_user["uuid"]
    workspace_id = test_user["workspace_id"]

    store = WorkspaceStore(workspace_uuid, actor_uuid)

    async def _override_get_workspace_id() -> int:
        return workspace_id

    async def _override_get_current_user() -> User:
        return User(
            id=str(test_user["id"]),
            uuid=actor_uuid,
            email=test_user["email"],
            role="user",
            created_at=datetime.now(UTC),
        )

    async def _override_get_workspace_store() -> AsyncGenerator[WorkspaceStore, None]:
        try:
            yield store
        finally:
            await store.close()

    async def _override_get_flashcard_service() -> FlashcardService:
        repo = PostgresFlashcardRepository(workspace_id)
        return FlashcardService(repo, workspace_id, int(test_user["id"]), store)

    test_app = FastAPI()
    test_app.include_router(flashcards_router)
    test_app.dependency_overrides[get_workspace_id] = _override_get_workspace_id
    test_app.dependency_overrides[get_current_user] = _override_get_current_user
    test_app.dependency_overrides[get_workspace_store] = _override_get_workspace_store
    test_app.dependency_overrides[get_flashcard_service] = _override_get_flashcard_service

    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client._flashcards_test_store = store  # type: ignore[attr-defined]
        yield client


@pytest.mark.unit
@pytest.mark.asyncio
async def test_due_cards_endpoint_returns_hydrated_content(
    db_pool, test_user, flashcards_client
):
    """GET /due returns front/back text rehydrated from node content."""
    store = flashcards_client._flashcards_test_store  # type: ignore[attr-defined]

    card_uuid = generate_uuid()
    cloze_uuid = generate_uuid()
    await store.create_node(
        node_id=card_uuid,
        kind="block",
        initial_content=[
            {
                "type": "paragraph",
                "children": [{"text": "Endpoint front"}],
            }
        ],
    )
    await store.create_node(
        node_id=cloze_uuid,
        kind="block",
        parent_id=card_uuid,
        index=0,
        initial_content=[
            {
                "type": "paragraph",
                "children": [{"text": "Endpoint cloze"}],
            }
        ],
        class_ids=[SYSTEM_CLASS_UUIDS["cloze"]],
    )
    repo = PostgresFlashcardRepository(test_user["workspace_id"])
    await repo.create(
        node_uuid=card_uuid,
        workspace_id=test_user["workspace_id"],
        user_id=int(test_user["id"]),
        front_text="",
        back_text="",
    )

    response = await flashcards_client.get("/flashcards/due")
    assert response.status_code == 200
    data = response.json()
    assert data["total_due"] == 1
    assert data["cards"][0]["node_uuid"] == card_uuid
    assert data["cards"][0]["front_text"] == "Endpoint front"
    assert data["cards"][0]["back_text"] == "Endpoint cloze"
