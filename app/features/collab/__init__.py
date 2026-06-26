"""Collab feature module.

Provides real-time collaboration endpoints:
- Server-Sent Events (SSE) for workspace-level changes
- WebSocket live sync for presence and applied-op broadcast (locks removed in v2)
"""

from app.features.collab.live_sync_ws import router as live_sync_ws_router
from app.features.collab.router import router

__all__ = ["live_sync_ws_router", "router"]
