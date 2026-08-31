"""Export Profiles plugin backend setup."""

from __future__ import annotations

from app.plugins.core.context import PluginContext

from .continuous import ExportContinuousService
from .providers import BibliographicProvider
from .router import router, runtime


def setup(context: PluginContext) -> None:
    provider = BibliographicProvider()
    context.register_export_provider(provider)

    continuous = ExportContinuousService(context)
    context.register_op_listener(continuous.handle_operation)
    context.register_startup_hook(continuous.startup_reconcile)

    runtime.context = context
    runtime.continuous = continuous

    context.register_router(router, prefix="")
