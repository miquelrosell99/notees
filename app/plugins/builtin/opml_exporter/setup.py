"""OPML exporter plugin backend setup."""

from __future__ import annotations

from app.plugins.core.context import PluginContext

from .exporter import OpmlExporter


async def setup(context: PluginContext) -> None:
    context.register_exporter(OpmlExporter())
