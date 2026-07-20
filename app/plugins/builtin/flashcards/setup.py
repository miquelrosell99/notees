"""Flashcards plugin backend setup."""

from __future__ import annotations

from fastapi import APIRouter

from app.core.workspace_store import WorkspaceStore
from app.db.connection import get_connection
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS
from app.plugins.core.context import PluginContext
from app.plugins.core.ports import ClassSideEffectContext
from app.relay.dependencies import get_relay_storage

from .repository import WorkspaceStoreFlashcardRepository
from .router import router as flashcards_router

router = APIRouter()
router.include_router(flashcards_router)


async def _on_card_class_changed(ctx: ClassSideEffectContext) -> None:
    """Create a flashcard row when the ``card`` class is assigned.

    The scheduling row is created with empty front/back text; the service
    hydrates live node content on every read, so stored values never go stale.
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

    store = WorkspaceStore(
        workspace_id=ctx.workspace_uuid,
        actor_id=ctx.actor_uuid,
        relay_storage=get_relay_storage(),
    )
    try:
        repo = WorkspaceStoreFlashcardRepository(store, workspace_id, user_id)
        await repo.create(
            node_uuid=ctx.node_uuid,
            front_text="",
            back_text="",
        )
    finally:
        await store.close()


def setup(context: PluginContext) -> None:
    # The inner flashcards_router already carries the `/flashcards` prefix; the
    # plugin mount point is just `/api/plugins/notees.flashcards`.
    context.register_router(router, prefix="")
    context.register_node_class_side_effect(
        class_uuid=SYSTEM_CLASS_UUIDS["card"],
        handler=_on_card_class_changed,
    )
