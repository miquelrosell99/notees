"""Presence helpers for the relay WebSocket channel (protocol/SPEC.md §5).

Presence is ephemeral collaboration state (who is focused/typing on which
block). It is never persisted and never touches the relay seq cursor.
"""

from __future__ import annotations

import zlib
from typing import Any

# Deterministic per-user palette, ported from the retired
# app/features/collab/live_sync_ws.py so existing color assignments are stable.
PRESENCE_COLORS = [
    "#ef4444",
    "#f97316",
    "#f59e0b",
    "#84cc16",
    "#10b981",
    "#06b6d4",
    "#3b82f6",
    "#6366f1",
    "#8b5cf6",
    "#d946ef",
    "#f43f5e",
]


def color_for_user_id(user_id: int) -> str:
    """Deterministic color for a numeric user id."""
    return PRESENCE_COLORS[user_id % len(PRESENCE_COLORS)]


def color_for_actor(actor_id: str) -> str:
    """Deterministic color when only the actor UUID is known."""
    return PRESENCE_COLORS[zlib.crc32(actor_id.encode()) % len(PRESENCE_COLORS)]


def build_presence_user(user: dict[str, Any] | None, actor_id: str) -> dict[str, Any]:
    """Build the wire ``user`` object carried by presence frames.

    ``user`` is the authenticated user dict from the users table when
    available; ``actor_id`` (the user UUID) is always the wire identity.
    """
    name = (user.get("name") if user else None) or "User"
    numeric_id = user.get("id") if user else None
    color = color_for_user_id(int(numeric_id)) if numeric_id is not None else color_for_actor(actor_id)
    return {"id": actor_id, "name": name, "color": color}
