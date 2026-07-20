"""Flashcard domain service with SM-2 scheduling.

A flashcard is a node with the ``card`` system class. Its front is the card
node's own content; its back is built from the node's direct children that
carry the ``cloze`` system class. This lets users author cards as normal
outlines and turn child bullets into cloze deletions.

During Phase 8 the legacy ``NodeRepository`` dependency was removed. The
service now rehydrates front/back text from the operation-log derived state on
every read, so stored values are only used as a fallback when the node cannot
be found.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from app.domain.entities.constants import SYSTEM_CLASS_UUIDS

from .port import FlashcardData, FlashcardRepository

if TYPE_CHECKING:
    from app.core.workspace_store import WorkspaceStore

# Separator used when joining multiple cloze children into a single back text.
CLOZE_SEPARATOR = "\n\n---\n\n"


def _extract_text(content: Any) -> str:
    """Extract plain text from a node's content AST."""
    if not content:
        return ""

    def _walk(node: Any) -> str:
        if isinstance(node, dict):
            if "text" in node:
                text = node["text"]
                if isinstance(text, str):
                    return text
                return ""
            return "".join(_walk(child) for child in node.get("children", []))
        if isinstance(node, list):
            return "".join(_walk(child) for child in node)
        if isinstance(node, str):
            return node
        return ""

    return _walk(content).strip()


class FlashcardService:
    """Domain service for flashcard review scheduling."""

    def __init__(
        self,
        repo: FlashcardRepository,
        workspace_id: int,
        user_id: int,
        store: WorkspaceStore | None = None,
    ) -> None:
        self._repo = repo
        self._workspace_id = workspace_id
        self._user_id = user_id
        self._store = store

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
        return await self._hydrate(card)

    async def get_by_node_uuid(self, node_uuid: str) -> FlashcardData | None:
        """Return the flashcard for a node, with live front/back content."""
        card = await self._repo.get_by_node_uuid(node_uuid)
        if not card:
            return None
        return await self._hydrate(card)

    async def get_due_cards(self, limit: int = 100) -> list[FlashcardData]:
        """Return cards due for review, with live front/back content."""
        cards = await self._repo.get_due_cards(self._workspace_id, self._user_id, limit)
        return [await self._hydrate(card) for card in cards]

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
        return await self._hydrate(updated)

    async def get_stats(self) -> dict[str, int]:
        """Return workspace flashcard statistics."""
        return await self._repo.get_stats(self._workspace_id, self._user_id)

    async def _hydrate(self, card: FlashcardData) -> FlashcardData:
        """Override stored front/back with live node content from derived state."""
        if self._store is None:
            return card

        await self._store.sync()

        rows = await self._store.query(
            "SELECT content FROM node WHERE id = ?", (card.node_uuid,)
        )
        if not rows:
            return card

        front_text = _extract_text(json.loads(rows[0]["content"]))

        cloze_uuid = SYSTEM_CLASS_UUIDS["cloze"]
        children = await self._store.query(
            """
            SELECT content FROM node
            WHERE parent_id = ? AND class_ids LIKE ?
            ORDER BY id
            """,
            (card.node_uuid, f'%"{cloze_uuid}"%'),
        )

        back_text = ""
        if children:
            back_parts = [
                _extract_text(json.loads(row["content"])) for row in children
            ]
            back_text = CLOZE_SEPARATOR.join(part for part in back_parts if part)

        return replace(card, front_text=front_text, back_text=back_text)
