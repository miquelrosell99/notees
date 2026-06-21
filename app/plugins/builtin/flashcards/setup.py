"""Flashcards plugin backend setup."""

from __future__ import annotations

from fastapi import APIRouter

from app.plugins.core.context import PluginContext

from .router import router as flashcards_router

router = APIRouter()
router.include_router(flashcards_router)


async def setup(context: PluginContext) -> None:
    context.register_router(router, prefix="flashcards")
    # TODO: register class side effect for SYSTEM_CLASS_UUIDS.card so assigning
    # the card class automatically creates the flashcard record.
