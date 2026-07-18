"""Flashcard REST API."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.db.connection import get_connection
from app.dependencies import get_workspace_id

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


async def _node_uuid_to_id(node_uuid: str, workspace_id: int) -> int:
    """Resolve a public node UUID to its internal numeric ID.

    TODO(Phase 8 compat): The flashcard table still stores internal numeric
    ``node_id`` values, so we query the legacy ``node`` PostgreSQL table for
    UUID<->ID mapping. Once flashcards migrate to operation-log UUIDs, replace
    this with WorkspaceStore lookups.
    """
    async with get_connection() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
            node_uuid,
            workspace_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="Node not found")
    return row["id"]


async def _node_id_to_uuid(node_id: int, workspace_id: int) -> str:
    """Resolve an internal numeric node ID to its public UUID."""
    async with get_connection() as conn:
        row = await conn.fetchrow(
            "SELECT uuid FROM node WHERE id = $1 AND workspace_id = $2",
            node_id,
            workspace_id,
        )
    return str(row["uuid"]) if row else ""


async def _to_response(
    card,
    workspace_id: int,
) -> FlashcardResponse:
    node_uuid = await _node_id_to_uuid(card.node_id, workspace_id)
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
    workspace_id: int = Depends(get_workspace_id),
):
    """Return cards due for review, including new cards."""
    cards = await service.get_due_cards(limit=limit)
    return ReviewQueueResponse(
        cards=[await _to_response(c, workspace_id) for c in cards],
        total_due=len(cards),
    )


async def _resolve_node_id(
    body: FlashcardCreateRequest,
    workspace_id: int,
) -> int:
    """Resolve a public node UUID to an internal numeric ID."""
    if body.node_id is not None:
        return body.node_id
    if body.node_uuid is None:
        raise HTTPException(422, "Either node_id or node_uuid is required")
    return await _node_uuid_to_id(body.node_uuid, workspace_id)


@router.post("/", response_model=FlashcardResponse)
async def create_flashcard(
    body: FlashcardCreateRequest,
    service: FlashcardService = Depends(get_flashcard_service),
    workspace_id: int = Depends(get_workspace_id),
):
    """Create or update a flashcard for a card-class node."""
    node_id = await _resolve_node_id(body, workspace_id)
    try:
        card = await service.create_flashcard(node_id, body.front_text, body.back_text)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return await _to_response(card, workspace_id)


@router.get("/node/{node_uuid}", response_model=FlashcardResponse)
async def get_flashcard_by_node(
    node_uuid: str,
    service: FlashcardService = Depends(get_flashcard_service),
    workspace_id: int = Depends(get_workspace_id),
):
    """Get flashcard by node UUID."""
    node_id = await _node_uuid_to_id(node_uuid, workspace_id)
    card = await service.get_by_node_id(node_id)
    if not card:
        raise HTTPException(404, "Flashcard not found")
    return await _to_response(card, workspace_id)


@router.post("/node/{node_uuid}/review", response_model=ReviewResultResponse)
async def review_flashcard(
    body: FlashcardReviewRequest,
    node_uuid: str,
    service: FlashcardService = Depends(get_flashcard_service),
    workspace_id: int = Depends(get_workspace_id),
):
    """Grade a flashcard review and update its schedule."""
    node_id = await _node_uuid_to_id(node_uuid, workspace_id)
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
