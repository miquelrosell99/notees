"""KOReader plugin backend setup."""

from __future__ import annotations

from fastapi import APIRouter

from app.plugins.core.context import PluginContext

from .router import router as koreader_router
from .sync import KOReaderSyncSource

router = APIRouter()
router.include_router(koreader_router)


async def setup(context: PluginContext) -> None:
    context.register_router(router, prefix="koreader")
    context.register_sync_source(KOReaderSyncSource())
