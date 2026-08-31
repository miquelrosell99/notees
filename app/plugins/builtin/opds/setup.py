"""OPDS plugin backend setup."""

from __future__ import annotations

from app.plugins.core.context import PluginContext

from .router import router, runtime


def setup(context: PluginContext) -> None:
    runtime.context = context
    context.register_router(router, prefix="")
