"""EPUB plugin backend setup."""

from __future__ import annotations

from app.plugins.core.context import PluginContext

from .handler import EpubMetadataHandler
from .router import router


def setup(context: PluginContext) -> None:
    context.register_asset_metadata_handler(EpubMetadataHandler())
    context.register_router(router, prefix="")
