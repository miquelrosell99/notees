"""Flashcards plugin backend setup."""

from __future__ import annotations

from fastapi import APIRouter

from app.db.connection import get_connection
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS
from app.plugins.core.context import PluginContext
from app.plugins.core.ports import ClassSideEffectContext

from .repository import PostgresFlashcardRepository
from .router import router as flashcards_router

router = APIRouter()
router.include_router(flashcards_router)


async def _on_card_class_changed(ctx: ClassSideEffectContext) -> None:
    """Create a flashcard row when the ``card`` class is assigned.

    The row is created with empty front/back text; the service hydrates live
    node content on every read, so the stored values never go stale.
    """
    if not ctx.added:
        return

    async with get_connection() as conn:
        workspace_row = await conn.fetchrow(
            "SELECT id FROM workspace WHERE uuid = $1", ctx.workspace_uuid
        )
        if workspace_row is None:
            return
        workspace_id = workspace_row["id"]

        user_row = await conn.fetchrow(
            'SELECT id FROM "user" WHERE uuid = $1', ctx.actor_uuid
        )
        if user_row is None:
            return
        user_id = user_row["id"]

    repo = PostgresFlashcardRepository(workspace_id)
    await repo.create(
        node_uuid=ctx.node_uuid,
        workspace_id=workspace_id,
        user_id=user_id,
        front_text="",
        back_text="",
    )


async def setup(context: PluginContext) -> None:
    # The inner flashcards_router already carries the `/flashcards` prefix; the
    # plugin mount point is just `/api/plugins/notees.flashcards`.
    context.register_router(router, prefix="")
    context.register_node_class_side_effect(
        class_uuid=SYSTEM_CLASS_UUIDS["card"],
        handler=_on_card_class_changed,
    )
