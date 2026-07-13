"""BibTeX plugin backend setup."""

from __future__ import annotations

from app.plugins.core.context import PluginContext

from .importer import BibTeXImporter


async def setup(context: PluginContext) -> None:
    context.register_importer(BibTeXImporter())
