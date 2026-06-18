"""Routers package.

Exports all API routers for the application.
Uses the new node-centric architecture where everything is a node.
"""

from app.features.activity.router import router as activity_router
from app.features.admin.router import router as admin_router
from app.features.assets.router import router as assets_router
from app.features.auth.router import router as auth_router
from app.features.export.router import router as export_router
from app.features.nodes.router import router as nodes_router
from app.features.notifications.router import router as notifications_router
from app.features.properties.router import router as properties_router
from app.features.properties.router.values import router as property_values_router
from app.features.shares.router import workspace_shares_router as shares_router
from app.features.sync.router import router as sync_router
from app.features.tasks.router import router as tasks_router
from app.features.undo.router import router as undo_router
from app.features.workspaces.router import router as workspaces_router

# Property value endpoints are mounted under the nodes router
nodes_router.include_router(property_values_router)

__all__ = [
    "auth_router",
    "workspaces_router",
    "nodes_router",
    "properties_router",
    "sync_router",
    "export_router",
    "assets_router",
    "undo_router",
    "tasks_router",
    "activity_router",
    "notifications_router",
    "admin_router",
    "shares_router",
]
