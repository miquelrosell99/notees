"""Library plugin backend setup.

The Library is primarily a view plugin (frontend), but the add-by-identifier
flow (Task 13) needs backend routes: metadata providers must be called
server-side (no CORS, no auth tokens in the browser).
"""

from __future__ import annotations

from app.plugins.core.context import PluginContext

from .router import router, runtime


def setup(context: PluginContext) -> None:
    runtime.context = context
    context.register_router(router, prefix="")
