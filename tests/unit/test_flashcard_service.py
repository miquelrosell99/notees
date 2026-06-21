"""Unit tests for the flashcard SM-2 scheduler."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.plugins.builtin.flashcards.port import FlashcardData, FlashcardRepository
from app.plugins.builtin.flashcards.service import FlashcardService


@dataclass
class FakeFlashcardRepository(FlashcardRepository):
    """In-memory flashcard repository for unit tests."""

    cards: dict[int, FlashcardData] = field(default_factory=dict)
    next_id: int = 1

    async def create(
        self,
        node_id: int,
        workspace_id: int,
        user_id: int,
        front_text: str,
        back_text: str,
    ) -> FlashcardData:
        now = datetime.now(UTC)
        card = FlashcardData(
            id=self.next_id,
            uuid=f"card-{self.next_id}",
            node_id=node_id,
            workspace_id=workspace_id,
            user_id=user_id,
            front_text=front_text,
            back_text=back_text,
            ease_factor=2.5,
            interval_days=0,
            repetitions=0,
            lapses=0,
            due_date=None,
            last_reviewed_at=None,
            active=True,
            create_date=now,
            write_date=now,
        )
        self.next_id += 1
        self.cards[node_id] = card
        return card

    async def get_by_node_id(self, node_id: int) -> FlashcardData | None:
        return self.cards.get(node_id)

    async def get_due_cards(
        self,
        workspace_id: int,
        user_id: int,
        limit: int = 100,
    ) -> list[FlashcardData]:
        now = datetime.now(UTC)
        return [
            c for c in self.cards.values()
            if c.workspace_id == workspace_id and c.user_id == user_id and c.active and (c.due_date is None or c.due_date <= now)
        ][:limit]

    async def update_srs(
        self,
        node_id: int,
        ease_factor: float,
        interval_days: int,
        repetitions: int,
        lapses: int,
        due_date: datetime,
        last_reviewed_at: datetime,
    ) -> None:
        card = self.cards[node_id]
        card.ease_factor = ease_factor
        card.interval_days = interval_days
        card.repetitions = repetitions
        card.lapses = lapses
        card.due_date = due_date
        card.last_reviewed_at = last_reviewed_at
        card.write_date = datetime.now(UTC)

    async def delete(self, node_id: int) -> None:
        self.cards.pop(node_id, None)

    async def get_stats(self, workspace_id: int, user_id: int) -> dict[str, Any]:
        now = datetime.now(UTC)
        filtered = [c for c in self.cards.values() if c.workspace_id == workspace_id and c.user_id == user_id]
        return {
            "total_cards": len(filtered),
            "due_now": len([c for c in filtered if c.active and (c.due_date is None or c.due_date <= now)]),
            "new_cards": len([c for c in filtered if c.repetitions == 0]),
            "mature_cards": len([c for c in filtered if c.repetitions >= 2]),
        }


@pytest.fixture
def service():
    repo = FakeFlashcardRepository()
    return FlashcardService(repo, workspace_id=1, user_id=1), repo


@pytest.mark.unit
@pytest.mark.asyncio
async def test_create_flashcard_starts_with_default_srs(service):
    svc, repo = service
    card = await svc.create_flashcard(node_id=10, front_text="Q", back_text="A")

    assert card.node_id == 10
    assert card.front_text == "Q"
    assert card.back_text == "A"
    assert card.ease_factor == 2.5
    assert card.repetitions == 0
    assert card.interval_days == 0
    assert 10 in repo.cards


@pytest.mark.unit
@pytest.mark.asyncio
async def test_review_easy_progresses_through_sm2_intervals(service):
    svc, _repo = service
    card = await svc.create_flashcard(node_id=10, front_text="Q", back_text="A")

    # First perfect review: interval becomes 1 day.
    card = await svc.review_card(card.node_id, grade=5)
    assert card.repetitions == 1
    assert card.interval_days == 1

    # Second perfect review: interval becomes 6 days.
    card = await svc.review_card(card.node_id, grade=5)
    assert card.repetitions == 2
    assert card.interval_days == 6

    # Third perfect review: interval grows by the updated ease factor.
    # After two grade-5 reviews ease_factor is 2.7, so 6 * 2.7 = 16.2 -> 16.
    card = await svc.review_card(card.node_id, grade=5)
    assert card.repetitions == 3
    assert card.interval_days == 16


@pytest.mark.unit
@pytest.mark.asyncio
async def test_review_again_resets_repetitions_and_increments_lapses(service):
    svc, _repo = service
    card = await svc.create_flashcard(node_id=10, front_text="Q", back_text="A")

    # Two successful reviews first.
    card = await svc.review_card(card.node_id, grade=5)
    card = await svc.review_card(card.node_id, grade=5)
    assert card.repetitions == 2
    assert card.interval_days == 6
    assert card.lapses == 0

    # Failure resets the card.
    card = await svc.review_card(card.node_id, grade=1)
    assert card.repetitions == 0
    assert card.interval_days == 1
    assert card.lapses == 1


@pytest.mark.unit
@pytest.mark.asyncio
async def test_due_date_set_after_review(service):
    svc, _repo = service
    card = await svc.create_flashcard(node_id=10, front_text="Q", back_text="A")
    before = datetime.now(UTC)

    card = await svc.review_card(card.node_id, grade=3)

    assert card.due_date is not None
    assert card.due_date >= before + timedelta(days=card.interval_days - 1)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_get_stats_counts_new_and_mature_cards(service):
    svc, _repo = service
    await svc.create_flashcard(node_id=10, front_text="Q1", back_text="A1")
    await svc.create_flashcard(node_id=11, front_text="Q2", back_text="A2")
    await svc.review_card(11, grade=5)
    await svc.review_card(11, grade=5)

    stats = await svc.get_stats()

    assert stats["total_cards"] == 2
    assert stats["new_cards"] == 1
    assert stats["mature_cards"] == 1
    # The mature card was reviewed twice and is now due in the future.
    assert stats["due_now"] == 1
