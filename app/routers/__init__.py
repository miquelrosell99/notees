"""Routers package.

Exports all API routers for the application.
Uses the new node-centric architecture where everything is a node.
"""
from .auth import router as auth_router, get_current_user
from .workspaces import router as workspaces_router
from .nodes import router as nodes_router
from .properties import router as properties_router
from .sync import router as sync_router
from .export import router as export_router
from .assets import router as assets_router
from .undo import router as undo_router

__all__ = [
    "auth_router",
    "workspaces_router",
    "nodes_router",
    "properties_router",
    "sync_router",
    "export_router",
    "assets_router",
    "undo_router",
    "get_current_user",
]
