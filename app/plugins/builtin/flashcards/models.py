"""Pydantic models for flashcard endpoints."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class FlashcardCreateRequest(BaseModel):
    """Create a flashcard from an existing card-class node."""

    node_id: int | None = Field(None, ge=1)
    node_uuid: str | None = None
    front_text: str = Field(..., min_length=0)
    back_text: str = Field(..., min_length=0)


class FlashcardReviewRequest(BaseModel):
    """Grade a flashcard review."""

    grade: int = Field(..., ge=0, le=5, description="SM-2 grade: 0-5")


class FlashcardResponse(BaseModel):
    """Flashcard serialized response."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    uuid: str
    node_id: int
    node_uuid: str
    front_text: str
    back_text: str
    ease_factor: float
    interval_days: int
    repetitions: int
    lapses: int
    due_date: datetime | None
    last_reviewed_at: datetime | None
    active: bool
    create_date: str
    write_date: str


class ReviewQueueResponse(BaseModel):
    """Cards due for review."""

    cards: list[FlashcardResponse]
    total_due: int


class ReviewResultResponse(BaseModel):
    """Result of reviewing a card."""

    grade: int
    interval_days: int
    due_date: datetime


class FlashcardStatsResponse(BaseModel):
    """Flashcard review statistics."""

    total_cards: int
    due_now: int
    new_cards: int
    mature_cards: int
