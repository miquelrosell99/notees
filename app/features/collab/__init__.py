"""Collab feature module.

Provides real-time collaboration endpoints:
- Server-Sent Events (SSE) for workspace-level changes

Presence and op broadcast moved to the relay WebSocket channel
(/api/relay/ws/{workspace_id}); the legacy /api/ws/live channel is retired.
"""

from app.features.collab.router import router

__all__ = ["router"]
