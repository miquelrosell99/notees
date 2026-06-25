"""Flashcard REST API."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_node_repository
from app.features.nodes.port import NodeRepository

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


async def _to_response(card, node_repo: NodeRepository | None = None) -> FlashcardResponse:
    node_uuid = ""
    if node_repo is not None:
        node = await node_repo.get_by_id(card.node_id)
        if node is not None:
            node_uuid = str(node.uuid)
    return FlashcardResponse(
        id=card.id,
        uuid=card.uuid,
        node_id=card.node_id,
        node_uuid=node_uuid,
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
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Return cards due for review, including new cards."""
    cards = await service.get_due_cards(limit=limit)
    return ReviewQueueResponse(cards=[await _to_response(c, node_repo) for c in cards], total_due=len(cards))


async def _resolve_node_id(
    body: FlashcardCreateRequest,
    node_repo: NodeRepository,
) -> int:
    """Resolve a public node UUID to an internal numeric ID."""
    if body.node_id is not None:
        return body.node_id
    if body.node_uuid is None:
        raise HTTPException(422, "Either node_id or node_uuid is required")
    node = await node_repo.get_by_uuid(body.node_uuid)
    if node is None or node.id is None:
        raise HTTPException(404, "Node not found")
    return node.id


@router.post("/", response_model=FlashcardResponse)
async def create_flashcard(
    body: FlashcardCreateRequest,
    service: FlashcardService = Depends(get_flashcard_service),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Create or update a flashcard for a card-class node."""
    node_id = await _resolve_node_id(body, node_repo)
    try:
        card = await service.create_flashcard(node_id, body.front_text, body.back_text)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return await _to_response(card, node_repo)


@router.get("/node/{node_uuid}", response_model=FlashcardResponse)
async def get_flashcard_by_node(
    node_uuid: str,
    service: FlashcardService = Depends(get_flashcard_service),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Get flashcard by node UUID."""
    node = await node_repo.get_by_uuid(node_uuid)
    if node is None or node.id is None:
        raise HTTPException(404, "Node not found")
    card = await service.get_by_node_id(node.id)
    if not card:
        raise HTTPException(404, "Flashcard not found")
    return await _to_response(card, node_repo)


@router.post("/node/{node_uuid}/review", response_model=ReviewResultResponse)
async def review_flashcard(
    body: FlashcardReviewRequest,
    node_uuid: str,
    service: FlashcardService = Depends(get_flashcard_service),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Grade a flashcard review and update its schedule."""
    node = await node_repo.get_by_uuid(node_uuid)
    if node is None or node.id is None:
        raise HTTPException(404, "Node not found")
    try:
        updated = await service.review_card(node.id, body.grade)
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
