"""Hello plugin setup."""

from __future__ import annotations

from fastapi import APIRouter

from app.plugins.core.context import PluginContext

router = APIRouter()


@router.get("/greet")
async def greet():
    return {"message": "Hello from the Notees plugin system!"}


async def setup(context: PluginContext) -> None:
    context.register_router(router, prefix="hello")
