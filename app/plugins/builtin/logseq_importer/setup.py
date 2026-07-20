"""Logseq importer plugin backend setup."""

from __future__ import annotations

from fastapi import APIRouter

from app.plugins.core.context import PluginContext

from .importer import LogseqFolderImporter
from .router import router as logseq_router

router = APIRouter()
router.include_router(logseq_router)


def setup(context: PluginContext) -> None:
    context.register_router(router, prefix="logseq")
    context.register_importer(LogseqFolderImporter())
