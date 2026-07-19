"""Flashcard domain service with SM-2 scheduling.

A flashcard is a node with the ``card`` system class. Its front is the card
node's own content; its back is built from the node's direct children that
carry the ``cloze`` system class. This lets users author cards as normal
outlines and turn child bullets into cloze deletions.

During Phase 8 the legacy ``NodeRepository`` dependency was removed.  The
service now works with the stored front/back values; callers that need live
node content can hydrate it separately from the operation-log derived state.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from .port import FlashcardData, FlashcardRepository


class FlashcardService:
    """Domain service for flashcard review scheduling."""

    def __init__(
        self,
        repo: FlashcardRepository,
        workspace_id: int,
        user_id: int,
    ) -> None:
        self._repo = repo
        self._workspace_id = workspace_id
        self._user_id = user_id

    async def create_flashcard(
        self,
        node_uuid: str,
        front_text: str,
        back_text: str,
    ) -> FlashcardData:
        """Create a flashcard record for the given card node."""
        card = await self._repo.create(
            node_uuid=node_uuid,
            workspace_id=self._workspace_id,
            user_id=self._user_id,
            front_text=front_text,
            back_text=back_text,
        )
        return card

    async def get_by_node_uuid(self, node_uuid: str) -> FlashcardData | None:
        """Return the flashcard for a node."""
        return await self._repo.get_by_node_uuid(node_uuid)

    async def get_due_cards(self, limit: int = 100) -> list[FlashcardData]:
        """Return cards due for review."""
        return await self._repo.get_due_cards(self._workspace_id, self._user_id, limit)

    async def review_card(self, node_uuid: str, grade: int) -> FlashcardData:
        """Grade a card and update its SM-2 schedule.

        Grade mapping (0-5):
        0 = complete blackout
        1 = incorrect response, correct one shown
        2 = incorrect response, easy recall
        3 = correct with serious difficulty
        4 = correct with hesitation
        5 = perfect response
        """
        card = await self._repo.get_by_node_uuid(node_uuid)
        if not card:
            raise ValueError(f"Flashcard not found for node {node_uuid}")

        now = datetime.now(UTC)
        ease_factor = card.ease_factor
        interval_days = card.interval_days
        repetitions = card.repetitions
        lapses = card.lapses

        if grade < 3:
            repetitions = 0
            interval_days = 1
            lapses += 1
        else:
            repetitions += 1
            if repetitions == 1:
                interval_days = 1
            elif repetitions == 2:
                interval_days = 6
            else:
                interval_days = max(1, round(interval_days * ease_factor))

            ease_factor = max(
                1.3,
                ease_factor + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)),
            )

        due_date = now + timedelta(days=interval_days)
        await self._repo.update_srs(
            node_uuid=node_uuid,
            ease_factor=ease_factor,
            interval_days=interval_days,
            repetitions=repetitions,
            lapses=lapses,
            due_date=due_date,
            last_reviewed_at=now,
        )
        updated = await self._repo.get_by_node_uuid(node_uuid)
        if not updated:
            raise RuntimeError("Flashcard disappeared after review")
        return updated

    async def get_stats(self) -> dict[str, int]:
        """Return workspace flashcard statistics."""
        return await self._repo.get_stats(self._workspace_id, self._user_id)
