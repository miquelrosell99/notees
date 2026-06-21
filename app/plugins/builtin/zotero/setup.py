"""Zotero plugin backend setup."""

from __future__ import annotations

from fastapi import APIRouter

from app.plugins.core.context import PluginContext

from .router import router as zotero_router
from .sync import ZoteroSyncSource

router = APIRouter()
router.include_router(zotero_router)


async def setup(context: PluginContext) -> None:
    context.register_router(router, prefix="zotero")
    context.register_sync_source(ZoteroSyncSource())
