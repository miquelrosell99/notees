"""Lightweight live-sync WebSocket with server-side block locking.

Architecture:
- Server is the lock authority. Each block can be locked by at most one user.
- When a user focuses a block, the server grants or denies the lock.
- While locked, the user's edits are broadcast to other viewers in real time.
- Locks expire after 30s of inactivity (no heartbeat or edit).
- On blur or disconnect, the lock is released immediately.

Message protocol (JSON):
  Client -> Server:
    { "type": "focus", "block_uuid": "..." }
    { "type": "blur", "block_uuid": "..." }
    { "type": "block_update", "block_uuid": "...", "block_id": 123, "name": "..." }
    { "type": "heartbeat" }

  Server -> Client:
    { "type": "user_focus", "block_uuid": "...",
      "user": { "id": 1, "name": "Alice", "color": "#ef4444" } }
    { "type": "user_blur", "block_uuid": "...", "user_id": 1 }
    { "type": "block_locked", "block_uuid": "...", "user_id": 1 }
    { "type": "block_lock_denied", "block_uuid": "...",
      "reason": "already_locked", "locked_by": { "id": 2, "name": "Bob" } }
    { "type": "block_lock_released", "block_uuid": "...", "user_id": 1 }
    { "type": "lock_expired", "block_uuid": "...", "user_id": 1 }
    { "type": "block_updated", "block_uuid": "...", "block_id": 123,
      "name": "...", "user_id": 1 }
    { "type": "users_list", "users": [...] }
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth import authenticate_api_key, decode_token, get_user_by_id
from ..db.connection import clear_request_conn, get_pool
from ..domain.permissions import PermissionChecker
from ..infrastructure.redis_pubsub import collab_pubsub
from ..logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/ws/live", tags=["Live Sync"])

# Per-page connection tracking (in-memory, per-instance).
_page_connections: dict[str, set[_LiveSyncConnection]] = {}

# Per-page block locks: page_uuid -> block_uuid -> connection
_page_locks: dict[str, dict[str, _LiveSyncConnection]] = {}

# Lock timeout tasks: page_uuid -> block_uuid -> asyncio.Task
_lock_timers: dict[str, dict[str, asyncio.Task]] = {}

_LOCK_TIMEOUT_SECONDS = 30


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


async def _authenticate_ws(token: str, api_key: str | None = None) -> dict[str, Any] | None:
    """Authenticate a WebSocket connection using a JWT token or API key."""
    # Prefer API key if present
    if api_key:
        user = await authenticate_api_key(api_key)
        if user and user.get("is_active", True):
            return user
        return None

    # Fall back to JWT token
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


def _cancel_lock_timer(page_uuid: str, block_uuid: str) -> None:
    """Cancel the expiration timer for a block lock."""
    timer = _lock_timers.get(page_uuid, {}).pop(block_uuid, None)
    if timer and not timer.done():
        timer.cancel()


async def _release_lock(page_uuid: str, block_uuid: str, user_id: int) -> None:
    """Release a block lock and clean up state."""
    _cancel_lock_timer(page_uuid, block_uuid)
    locks = _page_locks.get(page_uuid, {})
    if locks.get(block_uuid) is not None:
        del locks[block_uuid]
        if not locks:
            _page_locks.pop(page_uuid, None)
        await _broadcast(
            page_uuid,
            {
                "type": "block_lock_released",
                "block_uuid": block_uuid,
                "user_id": user_id,
            },
            user_id,
        )


async def _expire_lock(page_uuid: str, block_uuid: str, user_id: int) -> None:
    """Called when a lock times out due to inactivity."""
    locks = _page_locks.get(page_uuid, {})
    holder = locks.get(block_uuid)
    if holder and holder.user_id == user_id:
        holder.focused_block = None
        await _release_lock(page_uuid, block_uuid, user_id)
        await _broadcast(
            page_uuid,
            {
                "type": "lock_expired",
                "block_uuid": block_uuid,
                "user_id": user_id,
            },
            user_id,
        )


def _schedule_lock_expiration(page_uuid: str, block_uuid: str, user_id: int) -> None:
    """Schedule a timer that will expire the lock after inactivity."""
    _cancel_lock_timer(page_uuid, block_uuid)

    async def _timer() -> None:
        await asyncio.sleep(_LOCK_TIMEOUT_SECONDS)
        await _expire_lock(page_uuid, block_uuid, user_id)

    timers = _lock_timers.setdefault(page_uuid, {})
    timers[block_uuid] = asyncio.create_task(_timer())


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


async def _try_acquire_lock(
    connection: _LiveSyncConnection,
    page_uuid: str,
    block_uuid: str,
) -> bool:
    """Attempt to acquire a block lock for the connection.

    Returns True if lock granted, False if denied.
    """
    locks = _page_locks.setdefault(page_uuid, {})
    holder = locks.get(block_uuid)

    if holder is None:
        # Free — grant lock
        locks[block_uuid] = connection
        _schedule_lock_expiration(page_uuid, block_uuid, connection.user_id)
        await _broadcast(
            page_uuid,
            {
                "type": "block_locked",
                "block_uuid": block_uuid,
                "user_id": connection.user_id,
            },
            connection.user_id,
        )
        return True

    if holder.user_id == connection.user_id:
        # Same user already holds it (e.g. re-focus after blur) — refresh
        locks[block_uuid] = connection
        _schedule_lock_expiration(page_uuid, block_uuid, connection.user_id)
        return True

    # Denied — send to requester only
    await connection.send(
        {
            "type": "block_lock_denied",
            "block_uuid": block_uuid,
            "reason": "already_locked",
            "locked_by": {
                "id": holder.user_id,
                "name": holder.user.get("name", "User"),
                "color": _user_color(holder.user_id),
            },
        }
    )
    return False


# Simple per-connection rate limiter for block_update messages
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


@router.websocket("/{page_uuid}")
async def live_sync_websocket(
    websocket: WebSocket,
    page_uuid: str,
    token: str = "",
    api_key: str = "",
) -> None:
    """WebSocket endpoint for lightweight live block sync with locking.

    Authentication:
      - JWT: pass `token` query parameter
      - API Key: pass `api_key` query parameter
    """
    # Clear any inherited request-scoped connection (AGENTS.md rule)
    clear_request_conn()

    # 1. Authenticate
    user = await _authenticate_ws(token, api_key=api_key or None)
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
    update_throttler = _BlockUpdateThrottler(max_per_second=10.0)

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
                    await _release_lock(page_uuid, connection.focused_block, user_id)
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

                # Try to acquire lock for new block
                lock_granted = await _try_acquire_lock(connection, page_uuid, block_uuid)
                if lock_granted:
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
                    await _release_lock(page_uuid, block_uuid, user_id)
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
                # Verify sender holds the lock
                locks = _page_locks.get(page_uuid, {})
                holder = locks.get(block_uuid)
                if holder is None or holder.user_id != user_id:
                    # Lock lost or never held — re-sync client
                    await connection.send(
                        {
                            "type": "block_lock_denied",
                            "block_uuid": block_uuid,
                            "reason": "lock_lost",
                        }
                    )
                    continue
                # Refresh lock timer on edit activity
                _schedule_lock_expiration(page_uuid, block_uuid, user_id)
                await _broadcast(
                    page_uuid,
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
                # Refresh lock timer for currently focused block
                if connection.focused_block:
                    locks = _page_locks.get(page_uuid, {})
                    holder = locks.get(connection.focused_block)
                    if holder is not None and holder.user_id == user_id:
                        _schedule_lock_expiration(
                            page_uuid, connection.focused_block, user_id
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

        # Release any held locks
        if connection.focused_block:
            await _release_lock(page_uuid, connection.focused_block, user_id)
            await _broadcast(
                page_uuid,
                {
                    "type": "user_blur",
                    "block_uuid": connection.focused_block,
                    "user_id": user_id,
                },
                user_id,
            )
