"""Lightweight live-sync WebSocket for presence and applied-op broadcast.

The v2 sync protocol removes server-side block locks in favor of optimistic
vector-clock sync (POST /sync/batch). The WebSocket remains useful for:

- Real-time presence: who is focused/typing on which block.
- Broadcasting operations applied by other clients so the local UI can
  invalidate/refetch quickly.

Message protocol (JSON):
  Client -> Server:
    { "type": "focus", "block_uuid": "..." }
    { "type": "blur", "block_uuid": "..." }
    { "type": "typing", "block_uuid": "..." }
    { "type": "heartbeat" }

  Server -> Client:
    { "type": "user_focus", "block_uuid": "...",
      "user": { "id": 1, "name": "Alice", "color": "#ef4444" } }
    { "type": "user_blur", "block_uuid": "...", "user_id": 1 }
    { "type": "user_typing", "block_uuid": "...",
      "user": { "id": 1, "name": "Alice", "color": "#ef4444" } }
    { "type": "ops_applied", "ops": [...] }
    { "type": "users_list", "users": [...] }
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.db.connection import clear_request_conn, get_pool
from app.dependencies import (
    _make_permission_repository,
    _make_workspace_repository,
)
from app.domain.permissions import PermissionChecker
from app.features.auth import authenticate_api_key, decode_token, get_user_by_id
from app.infrastructure.redis_pubsub import collab_pubsub
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/ws/live", tags=["Live Sync"])

# Per-page connection tracking (in-memory, per-instance).
_page_connections: dict[str, set[_LiveSyncConnection]] = {}


class _LiveSyncConnection:
    def __init__(
        self,
        websocket: WebSocket,
        room_id: str,
        user: dict[str, Any],
    ) -> None:
        self.ws = websocket
        self.room_id = room_id
        self.user = user
        self.user_id = int(user["id"])
        self.focused_block: str | None = None

    async def send(self, msg: dict[str, Any]) -> None:
        with contextlib.suppress(Exception):
            await self.ws.send_text(json.dumps(msg))


async def _authenticate_ws(token: str, api_key: str | None = None) -> dict[str, Any] | None:
    """Authenticate a WebSocket connection using a JWT token or API key."""
    if api_key:
        user = await authenticate_api_key(api_key)
        if user and user.get("is_active", True):
            return user
        return None

    if not token:
        return None
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


async def _broadcast(
    room_id: str,
    message: dict[str, Any],
    sender_id: int,
    exclude: _LiveSyncConnection | None = None,
) -> None:
    """Broadcast to all local connections and Redis."""
    for conn in list(_page_connections.get(room_id, set())):
        if conn is not exclude:
            await conn.send(message)

    try:
        redis_msg = {**message, "sender_id": sender_id}
        await collab_pubsub.publish(f"live:{room_id}", json.dumps(redis_msg).encode())
    except (ConnectionError, OSError, RuntimeError):
        logger.exception(f"Failed to publish live sync message for {room_id}")


async def broadcast_ops(room_id: str, ops: list[dict[str, Any]]) -> None:
    """Broadcast applied operations to all connected clients in a room.

    This is the public hook used by SyncServiceV2 after a batch is committed.
    V2 clients subscribe to a workspace-scoped room, so ``room_id`` should be
    the workspace UUID.
    """
    await _broadcast(
        room_id,
        {"type": "ops_applied", "ops": ops},
        sender_id=0,
    )


async def _run_redis_loop(
    room_id: str, user_id: int, connection: _LiveSyncConnection
) -> None:
    """Module-level Redis subscriber loop for cross-instance live sync."""
    try:
        async for raw in collab_pubsub.subscribe(f"live:{room_id}"):
            try:
                msg = json.loads(raw.decode())
                if msg.get("sender_id") == user_id:
                    continue
                msg.pop("sender_id", None)
                await connection.send(msg)
            except Exception:
                pass
    except Exception:
        pass


async def _send_users_list(conn: _LiveSyncConnection) -> None:
    """Send current local users list to a new connection."""
    users: list[dict[str, Any]] = []
    for c in list(_page_connections.get(conn.room_id, set())):
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


# Simple per-connection rate limiter for legacy block_update messages
class _BlockUpdateThrottler:
    """Throttle block_update messages to max N per second per connection."""

    def __init__(self, max_per_second: float = 10.0) -> None:
        self.max_per_second = max_per_second
        self.min_interval = 1.0 / max_per_second
        self.last_time: float = 0.0

    def allow(self) -> bool:
        import time

        now = time.monotonic()
        if now - self.last_time >= self.min_interval:
            self.last_time = now
            return True
        return False


async def _authorize_v2_room(
    workspace_uuid: str, user: dict[str, Any]
) -> tuple[str, bool] | None:
    """Authorize a v2 workspace-scoped room. Returns (room_id, can_write) or None."""
    pool = await get_pool()
    user_id = int(user["id"])
    workspace_repo = _make_workspace_repository(pool)
    ws = await workspace_repo.get_by_uuid_for_user(workspace_uuid, user_id)
    if not ws:
        return None
    permission_repo = _make_permission_repository(pool, ws["id"], user_id)
    checker = PermissionChecker(user_id, permission_repo)
    if not await checker.can_read_workspace(ws["id"]):
        return None
    can_write = await checker.can_write_workspace(ws["id"])
    return workspace_uuid, can_write


@router.websocket("/{workspace_uuid}")
async def live_sync_websocket(
    websocket: WebSocket,
    workspace_uuid: str,
    token: str = "",
    api_key: str = "",
) -> None:
    """WebSocket endpoint for live presence and applied-op broadcast.

    Authentication:
      - JWT: HTTPOnly `access_token` cookie (preferred)
      - JWT: pass `token` query parameter
      - API Key: pass `api_key` query parameter

    The room is always workspace-scoped (v2 protocol). ``workspace_uuid`` must
    be the target workspace UUID.
    """
    clear_request_conn()

    cookie_token = websocket.cookies.get("access_token", "")
    effective_token = cookie_token or token
    user = await _authenticate_ws(effective_token, api_key=api_key or None)
    if not user:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    user_id = int(user["id"])

    auth_result = await _authorize_v2_room(workspace_uuid, user)
    if auth_result is None:
        await websocket.close(code=4004, reason="Workspace not found")
        return

    room_id, can_write = auth_result

    await websocket.accept()

    connection = _LiveSyncConnection(websocket, room_id, user)
    _page_connections.setdefault(room_id, set()).add(connection)
    update_throttler = _BlockUpdateThrottler(max_per_second=10.0)

    await _send_users_list(connection)

    redis_task: asyncio.Task | None = None
    redis_task = asyncio.create_task(_run_redis_loop(room_id, user_id, connection))

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
                        room_id,
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
                    room_id,
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
                        room_id,
                        {
                            "type": "user_blur",
                            "block_uuid": block_uuid,
                            "user_id": user_id,
                        },
                        user_id,
                        exclude=connection,
                    )

            elif msg_type == "typing" and isinstance(block_uuid, str):
                await _broadcast(
                    room_id,
                    {
                        "type": "user_typing",
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

            elif msg_type == "block_update":
                # Legacy broadcast-only path. Persistence happens through
                # POST /sync/batch in the v2 protocol.
                if not can_write:
                    continue
                if not update_throttler.allow():
                    await connection.send(
                        {
                            "type": "error",
                            "message": "Rate limit exceeded: too many block updates",
                        }
                    )
                    continue
                block_uuid = msg.get("block_uuid")
                if not isinstance(block_uuid, str):
                    continue
                await _broadcast(
                    room_id,
                    {
                        "type": "block_updated",
                        "block_uuid": block_uuid,
                        "block_id": msg.get("block_id"),
                        "name": msg.get("name"),
                        "user_id": user_id,
                    },
                    user_id,
                    exclude=connection,
                )

            elif msg_type == "heartbeat":
                # No-op in v2; presence is event-driven.
                pass

    except WebSocketDisconnect:
        pass
    except (ConnectionError, OSError, RuntimeError):
        logger.exception(f"Live sync WebSocket error for room {room_id}")
    finally:
        if redis_task and not redis_task.done():
            redis_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await redis_task

        _page_connections.setdefault(room_id, set()).discard(connection)
        if not _page_connections.get(room_id):
            _page_connections.pop(room_id, None)

        if connection.focused_block:
            await _broadcast(
                room_id,
                {
                    "type": "user_blur",
                    "block_uuid": connection.focused_block,
                    "user_id": user_id,
                },
                user_id,
            )
