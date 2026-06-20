"""Flashcard domain service with SM-2 scheduling.

A flashcard is a node with the ``card`` system class. Its front is the card
node's own content; its back is built from the node's direct children that
carry the ``cloze`` system class. This lets users author cards as normal
outlines and turn child bullets into cloze deletions.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.features.nodes.port import NodeRepository

    from .port import FlashcardData, FlashcardRepository


# Separator used when joining multiple cloze children into a single back text.
CLOZE_SEPARATOR = "\n\n---\n\n"


class FlashcardService:
    """Domain service for flashcard review scheduling."""

    def __init__(
        self,
        repo: FlashcardRepository,
        workspace_id: int,
        user_id: int,
        node_repo: NodeRepository | None = None,
    ) -> None:
        self._repo = repo
        self._workspace_id = workspace_id
        self._user_id = user_id
        self._node_repo = node_repo

    async def create_flashcard(
        self,
        node_id: int,
        front_text: str,
        back_text: str,
    ) -> FlashcardData:
        """Create a flashcard record for the given card node.

        The stored front/back values are overwritten by the live node content on
        read, so callers may pass empty strings.
        """
        card = await self._repo.create(
            node_id=node_id,
            workspace_id=self._workspace_id,
            user_id=self._user_id,
            front_text=front_text,
            back_text=back_text,
        )
        return await self._hydrate(card)

    async def get_by_node_id(self, node_id: int) -> FlashcardData | None:
        """Return the flashcard for a node, with live front/back content."""
        card = await self._repo.get_by_node_id(node_id)
        if not card:
            return None
        return await self._hydrate(card)

    async def get_due_cards(self, limit: int = 100) -> list[FlashcardData]:
        """Return cards due for review, with live front/back content."""
        cards = await self._repo.get_due_cards(self._workspace_id, self._user_id, limit)
        return [await self._hydrate(card) for card in cards]

    async def review_card(self, node_id: int, grade: int) -> FlashcardData:
        """Grade a card and update its SM-2 schedule.

        Grade mapping (0-5):
        0 = complete blackout
        1 = incorrect response, correct one shown
        2 = incorrect response, easy recall
        3 = correct with serious difficulty
        4 = correct with hesitation
        5 = perfect response
        """
        card = await self._repo.get_by_node_id(node_id)
        if not card:
            raise ValueError(f"Flashcard not found for node {node_id}")

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
            node_id=node_id,
            ease_factor=ease_factor,
            interval_days=interval_days,
            repetitions=repetitions,
            lapses=lapses,
            due_date=due_date,
            last_reviewed_at=now,
        )
        updated = await self._repo.get_by_node_id(node_id)
        if not updated:
            raise RuntimeError("Flashcard disappeared after review")
        return await self._hydrate(updated)

    async def get_stats(self) -> dict[str, int]:
        """Return workspace flashcard statistics."""
        return await self._repo.get_stats(self._workspace_id, self._user_id)

    async def _hydrate(self, card: FlashcardData) -> FlashcardData:
        """Derive front/back text from the card node and its cloze children.

        Falls back to the stored values if the node repository is unavailable or
        the node cannot be found.
        """
        if self._node_repo is None:
            return card

        node = await self._node_repo.get_by_id(card.node_id)
        if node is None:
            return card

        front_text = node.name or ""
        back_text = ""

        children = await self._node_repo.get_children(node.id)
        cloze_children = [child for child in children if child.is_cloze]
        if cloze_children:
            # Preserve sibling order for the back side.
            back_text = CLOZE_SEPARATOR.join(
                child.name.strip() for child in cloze_children if child.name
            )

        return replace(card, front_text=front_text, back_text=back_text)
