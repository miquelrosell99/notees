"""Repository port for flashcards."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass
class FlashcardData:
    """Domain data for a flashcard."""

    id: int
    uuid: str
    node_uuid: str
    workspace_id: int
    user_id: int
    front_text: str
    back_text: str
    ease_factor: float
    interval_days: int
    repetitions: int
    lapses: int
    due_date: datetime | None
    last_reviewed_at: datetime | None
    active: bool
    create_date: datetime
    write_date: datetime


class FlashcardRepository(ABC):
    """Port for flashcard persistence."""

    @abstractmethod
    async def create(
        self,
        node_uuid: str,
        workspace_id: int,
        user_id: int,
        front_text: str,
        back_text: str,
    ) -> FlashcardData:
        """Create a flashcard for the given node."""
        pass

    @abstractmethod
    async def get_by_node_uuid(self, node_uuid: str) -> FlashcardData | None:
        """Fetch flashcard by node UUID."""
        pass

    @abstractmethod
    async def get_due_cards(
        self,
        workspace_id: int,
        user_id: int,
        limit: int = 100,
    ) -> list[FlashcardData]:
        """Fetch active cards due for review (including new cards with null due_date)."""
        pass

    @abstractmethod
    async def update_srs(
        self,
        node_uuid: str,
        ease_factor: float,
        interval_days: int,
        repetitions: int,
        lapses: int,
        due_date: datetime,
        last_reviewed_at: datetime,
    ) -> None:
        """Update SRS state after a review."""
        pass

    @abstractmethod
    async def delete(self, node_uuid: str) -> None:
        """Delete flashcard for node."""
        pass

    @abstractmethod
    async def get_stats(self, workspace_id: int, user_id: int) -> dict[str, Any]:
        """Return review statistics."""
        pass
