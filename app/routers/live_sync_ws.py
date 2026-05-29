"""Lightweight live-sync WebSocket for automatic real-time collaboration.

Unlike the Yjs CRDT endpoint, this provides block-level presence and
immediate update broadcasting without requiring manual activation or
replacing the main editor.  It is designed to layer on top of the
existing REST-backed BlockEditor so that all block features (slash
commands, tasks, tables, etc.) continue to work while users see each
other's edits in near real time.

Message protocol (JSON):
  Client -> Server:
    { "type": "focus", "block_uuid": "..." }
    { "type": "blur", "block_uuid": "..." }
    { "type": "block_update", "block_uuid": "...", "block_id": 123,
      "name": "...", "version": 5 }

  Server -> Client:
    { "type": "user_focus", "block_uuid": "...",
      "user": { "id": 1, "name": "Alice", "color": "#ef4444" } }
    { "type": "user_blur", "block_uuid": "...", "user_id": 1 }
    { "type": "block_updated", "block_uuid": "...", "block_id": 123,
      "name": "...", "version": 5, "user_id": 1 }
    { "type": "users_list", "users": [...] }
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth import decode_token, get_user_by_id
from ..db.connection import clear_request_conn, get_pool
from ..domain.permissions import PermissionChecker
from ..infrastructure.redis_pubsub import collab_pubsub
from ..logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/ws/live", tags=["Live Sync"])

# Per-page connection tracking (in-memory, per-instance).
# For multi-instance deployments Redis carries cross-instance messages;
# presence lists are best-effort across instances.
_page_connections: dict[str, set[_LiveSyncConnection]] = {}


def _user_color(user_id: int) -> str:
    """Deterministic color for a user."""
    colors = [
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
    return colors[user_id % len(colors)]


class _LiveSyncConnection:
    def __init__(self, websocket: WebSocket, page_uuid: str, user: dict[str, Any]) -> None:
        self.ws = websocket
        self.page_uuid = page_uuid
        self.user = user
        self.user_id = int(user["id"])
        self.focused_block: str | None = None

    async def send(self, msg: dict[str, Any]) -> None:
        with contextlib.suppress(Exception):
            await self.ws.send_text(json.dumps(msg))


async def _authenticate_ws(token: str) -> dict[str, Any] | None:
    """Authenticate a WebSocket connection using a JWT token."""
    payload = decode_token(token)
    if not payload:
        return None
    user_id = payload.get("user_id")
    if not user_id:
        return None
    user = await get_user_by_id(user_id)
    if not user or not user.get("is_active", True):
        return None
    return user


async def _broadcast(
    page_uuid: str,
    message: dict[str, Any],
    sender_id: int,
    exclude: _LiveSyncConnection | None = None,
) -> None:
    """Broadcast to all local connections and Redis."""
    # Local broadcast
    for conn in list(_page_connections.get(page_uuid, set())):
        if conn is not exclude:
            await conn.send(message)

    # Redis broadcast for cross-instance (tag with sender to avoid echoes)
    try:
        redis_msg = {**message, "sender_id": sender_id}
        await collab_pubsub.publish(f"live:{page_uuid}", json.dumps(redis_msg).encode())
    except Exception:
        logger.exception(f"Failed to publish live sync message for {page_uuid}")


async def _send_users_list(conn: _LiveSyncConnection) -> None:
    """Send current local users list to a new connection."""
    users: list[dict[str, Any]] = []
    for c in list(_page_connections.get(conn.page_uuid, set())):
        if c.user_id != conn.user_id and c.focused_block:
            users.append(
                {
                    "id": c.user_id,
                    "name": c.user.get("name", "User"),
                    "color": _user_color(c.user_id),
                    "block_uuid": c.focused_block,
                }
            )
    if users:
        await conn.send({"type": "users_list", "users": users})


@router.websocket("/{page_uuid}")
async def live_sync_websocket(
    websocket: WebSocket,
    page_uuid: str,
    token: str = "",
) -> None:
    """WebSocket endpoint for lightweight live block sync."""
    # Clear any inherited request-scoped connection (AGENTS.md rule)
    clear_request_conn()

    # 1. Authenticate
    user = await _authenticate_ws(token)
    if not user:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    user_id = int(user["id"])

    # 2. Resolve page node ID and check permissions
    pool = await get_pool()
    checker = PermissionChecker(pool, user_id)

    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, uuid::text FROM node WHERE uuid::text = $1 AND active = TRUE",
                page_uuid,
            )
    except Exception:
        logger.exception(f"Failed to resolve page {page_uuid}")
        await websocket.close(code=4002, reason="Internal error")
        return

    if not row or row["uuid"] != page_uuid:
        await websocket.close(code=4004, reason="Page not found")
        return

    node_id = row["id"]

    # 3. Authorize
    can_read = await checker.can_read_node(node_id)
    if not can_read:
        await websocket.close(code=4003, reason="Forbidden")
        return

    can_write = await checker.can_write_node(node_id)

    # 4. Accept WebSocket
    await websocket.accept()

    connection = _LiveSyncConnection(websocket, page_uuid, user)
    _page_connections.setdefault(page_uuid, set()).add(connection)

    # Send current local users list
    await _send_users_list(connection)

    # 5. Start Redis subscriber for cross-instance messages
    redis_task: asyncio.Task | None = None

    async def _redis_loop() -> None:
        try:
            async for raw in collab_pubsub.subscribe(f"live:{page_uuid}"):
                try:
                    msg = json.loads(raw.decode())
                    # Skip echoes of our own messages
                    if msg.get("sender_id") == user_id:
                        continue
                    # Remove internal sender_id before forwarding
                    msg.pop("sender_id", None)
                    await connection.send(msg)
                except Exception:
                    pass
        except Exception:
            pass

    redis_task = asyncio.create_task(_redis_loop())

    # 6. Main message loop
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type")
            block_uuid = msg.get("block_uuid")

            if msg_type == "focus" and isinstance(block_uuid, str):
                # Blur previous block if any
                if connection.focused_block and connection.focused_block != block_uuid:
                    await _broadcast(
                        page_uuid,
                        {
                            "type": "user_blur",
                            "block_uuid": connection.focused_block,
                            "user_id": user_id,
                        },
                        user_id,
                        exclude=connection,
                    )
                connection.focused_block = block_uuid
                await _broadcast(
                    page_uuid,
                    {
                        "type": "user_focus",
                        "block_uuid": block_uuid,
                        "user": {
                            "id": user_id,
                            "name": user.get("name", "User"),
                            "color": _user_color(user_id),
                        },
                    },
                    user_id,
                    exclude=connection,
                )

            elif msg_type == "blur" and isinstance(block_uuid, str):
                if connection.focused_block == block_uuid:
                    connection.focused_block = None
                    await _broadcast(
                        page_uuid,
                        {
                            "type": "user_blur",
                            "block_uuid": block_uuid,
                            "user_id": user_id,
                        },
                        user_id,
                        exclude=connection,
                    )

            elif msg_type == "block_update":
                if not can_write:
                    continue
                await _broadcast(
                    page_uuid,
                    {
                        "type": "block_updated",
                        "block_uuid": msg.get("block_uuid"),
                        "block_id": msg.get("block_id"),
                        "name": msg.get("name"),
                        "version": msg.get("version"),
                        "user_id": user_id,
                    },
                    user_id,
                    exclude=connection,
                )

    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception(f"Live sync WebSocket error for page {page_uuid}")
    finally:
        if redis_task and not redis_task.done():
            redis_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await redis_task

        # Remove connection
        _page_connections.setdefault(page_uuid, set()).discard(connection)
        if not _page_connections.get(page_uuid):
            _page_connections.pop(page_uuid, None)

        # Broadcast blur for any remaining focused block
        if connection.focused_block:
            await _broadcast(
                page_uuid,
                {
                    "type": "user_blur",
                    "block_uuid": connection.focused_block,
                    "user_id": user_id,
                },
                user_id,
            )
