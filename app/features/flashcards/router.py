"""Flashcard REST API."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path

from .dependencies import get_flashcard_service
from .models import (
    FlashcardCreateRequest,
    FlashcardResponse,
    FlashcardReviewRequest,
    FlashcardStatsResponse,
    ReviewQueueResponse,
    ReviewResultResponse,
)
from .service import FlashcardService

router = APIRouter(prefix="/flashcards", tags=["flashcards"])


def _to_response(card) -> FlashcardResponse:
    return FlashcardResponse(
        id=card.id,
        uuid=card.uuid,
        node_id=card.node_id,
        front_text=card.front_text,
        back_text=card.back_text,
        ease_factor=card.ease_factor,
        interval_days=card.interval_days,
        repetitions=card.repetitions,
        lapses=card.lapses,
        due_date=card.due_date,
        last_reviewed_at=card.last_reviewed_at,
        active=card.active,
        create_date=card.create_date.isoformat(),
        write_date=card.write_date.isoformat(),
    )


@router.get("/due", response_model=ReviewQueueResponse)
async def get_due_cards(
    limit: int = 100,
    service: FlashcardService = Depends(get_flashcard_service),
):
    """Return cards due for review, including new cards."""
    cards = await service.get_due_cards(limit=limit)
    return ReviewQueueResponse(cards=[_to_response(c) for c in cards], total_due=len(cards))


@router.post("/", response_model=FlashcardResponse)
async def create_flashcard(
    body: FlashcardCreateRequest,
    service: FlashcardService = Depends(get_flashcard_service),
):
    """Create or update a flashcard for a card-class node."""
    try:
        card = await service.create_flashcard(body.node_id, body.front_text, body.back_text)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _to_response(card)


@router.get("/node/{node_id}", response_model=FlashcardResponse)
async def get_flashcard_by_node(
    node_id: int = Path(..., ge=1),
    service: FlashcardService = Depends(get_flashcard_service),
):
    """Get flashcard by node ID."""
    card = await service.get_by_node_id(node_id)
    if not card:
        raise HTTPException(404, "Flashcard not found")
    return _to_response(card)


@router.post("/node/{node_id}/review", response_model=ReviewResultResponse)
async def review_flashcard(
    body: FlashcardReviewRequest,
    node_id: int = Path(..., ge=1),
    service: FlashcardService = Depends(get_flashcard_service),
):
    """Grade a flashcard review and update its schedule."""
    try:
        updated = await service.review_card(node_id, body.grade)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return ReviewResultResponse(
        grade=body.grade,
        interval_days=updated.interval_days,
        due_date=updated.due_date,
    )


@router.get("/stats", response_model=FlashcardStatsResponse)
async def get_flashcard_stats(
    service: FlashcardService = Depends(get_flashcard_service),
):
    """Return flashcard statistics for the current user/workspace."""
    stats = await service.get_stats()
    return FlashcardStatsResponse(
        total_cards=stats.get("total_cards", 0),
        due_now=stats.get("due_now", 0),
        new_cards=stats.get("new_cards", 0),
        mature_cards=stats.get("mature_cards", 0),
    )
