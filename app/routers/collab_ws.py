"""WebSocket endpoint for real-time collaborative editing.

Implements the y-websocket protocol over FastAPI WebSockets:
- Message type 0: Sync (Yjs sync protocol)
- Message type 1: Awareness (cursor positions, user presence)

Authentication via JWT token passed as a query parameter.
Permissions are enforced on connect (read) and per-update (write).
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth import decode_token, get_user_by_id
from ..db.connection import clear_request_conn, get_pool
from ..domain.permissions import PermissionChecker
from ..domain.services.collab_manager import CollabManager
from ..infrastructure.redis_pubsub import collab_pubsub
from ..logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/ws/collab", tags=["Collaboration"])

# Global collab manager (initialized lazily)
_collab_manager: CollabManager | None = None


async def _get_collab_manager() -> CollabManager:
    """Get or initialize the global CollabManager."""
    global _collab_manager
    if _collab_manager is None:
        pool = await get_pool()
        _collab_manager = CollabManager(pool, collab_pubsub)
        _collab_manager.start_cleanup_task()
    return _collab_manager


# Yjs message type constants
MSG_SYNC = 0
MSG_AWARENESS = 1

# Yjs sync step constants
SYNC_STEP1 = 0
SYNC_STEP2 = 1


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


async def _read_message(websocket: WebSocket) -> tuple[int, bytes] | None:
    """Read a binary message from the WebSocket.

    Returns (message_type, payload) or None if the message is not valid binary.
    """
    try:
        data = await websocket.receive_bytes()
    except Exception:
        return None
    if len(data) < 1:
        return None
    return data[0], data[1:]


async def _send_sync_step2(websocket: WebSocket, diff: bytes) -> None:
    """Send a SyncStep2 message (server -> client diff)."""
    await websocket.send_bytes(bytes([MSG_SYNC, SYNC_STEP2]) + diff)


async def _send_sync_step1(websocket: WebSocket, state_vector: bytes) -> None:
    """Send a SyncStep1 message (server -> client state vector request)."""
    await websocket.send_bytes(bytes([MSG_SYNC, SYNC_STEP1]) + state_vector)


async def _handle_client_loop(
    websocket: WebSocket,
    page_uuid: str,
    user: dict[str, Any],
    manager: CollabManager,
    write_allowed: bool,
) -> None:
    """Read messages from the client and process them."""
    while True:
        msg = await _read_message(websocket)
        if msg is None:
            continue

        msg_type, payload = msg

        if msg_type == MSG_SYNC:
            if len(payload) < 1:
                continue
            sync_type = payload[0]
            sync_payload = payload[1:]

            if sync_type == SYNC_STEP1:
                # Client sent state vector; respond with diff
                try:
                    diff = await manager.get_diff(page_uuid, sync_payload or None)
                    await _send_sync_step2(websocket, diff)
                except Exception:
                    logger.exception(f"Failed to compute diff for {page_uuid}")

            elif sync_type == SYNC_STEP2:
                # Client sent an update
                if not write_allowed:
                    # Re-sync client with canonical state (discard their update)
                    try:
                        diff = await manager.get_diff(page_uuid)
                        await _send_sync_step2(websocket, diff)
                    except Exception:
                        logger.exception(f"Failed to re-sync read-only client for {page_uuid}")
                    continue

                try:
                    await manager.apply_update(
                        page_uuid,
                        sync_payload,
                        user_uuid=user.get("uuid"),
                    )
                except Exception:
                    logger.exception(f"Failed to apply update for {page_uuid}")

        elif msg_type == MSG_AWARENESS:
            # Broadcast awareness to all other clients via pub/sub
            # Awareness is transient and not persisted
            try:
                await collab_pubsub.publish(
                    f"collab:{page_uuid}:awareness",
                    bytes([MSG_AWARENESS]) + payload,
                )
            except Exception:
                logger.exception(f"Failed to broadcast awareness for {page_uuid}")


async def _handle_pubsub_loop(
    websocket: WebSocket,
    page_uuid: str,
    user_uuid: str | None,
) -> None:
    """Subscribe to pub/sub channels and forward updates to the client."""
    try:
        async for message in collab_pubsub.subscribe(f"collab:{page_uuid}"):
            try:
                await websocket.send_bytes(bytes([MSG_SYNC, SYNC_STEP2]) + message)
            except Exception:
                # Client likely disconnected
                break
    except Exception:
        logger.exception(f"Pub/sub error for page {page_uuid}")


async def _handle_awareness_loop(
    websocket: WebSocket,
    page_uuid: str,
    user_uuid: str | None,
) -> None:
    """Subscribe to awareness channel and forward to client."""
    try:
        async for message in collab_pubsub.subscribe(f"collab:{page_uuid}:awareness"):
            try:
                await websocket.send_bytes(message)
            except Exception:
                break
    except Exception:
        logger.exception(f"Awareness pub/sub error for page {page_uuid}")


@router.websocket("/{page_uuid}")
async def collaboration_websocket(websocket: WebSocket, page_uuid: str, token: str = ""):
    """WebSocket endpoint for collaborative editing on a page.

    Query params:
        token: JWT access token.
    """
    # Clear any inherited request-scoped connection (AGENTS.md rule)
    clear_request_conn()

    # 1. Authenticate
    user = await _authenticate_ws(token)
    if not user:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    user_id = int(user["id"])
    user_uuid = user.get("uuid")

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

    if not row:
        await websocket.close(code=4004, reason="Page not found")
        return

    node_id = row["id"]
    actual_uuid = row["uuid"]

    # Ensure the URL UUID matches the DB UUID
    if actual_uuid != page_uuid:
        await websocket.close(code=4004, reason="Page not found")
        return

    # 3. Authorize: need read to connect, write to edit
    can_read = await checker.can_read_node(node_id)
    if not can_read:
        await websocket.close(code=4003, reason="Forbidden")
        return

    can_write = await checker.can_write_node(node_id)

    # 4. Accept WebSocket
    await websocket.accept()

    # 5. Load document and send initial sync
    manager = await _get_collab_manager()
    try:
        # Send SyncStep1 with server state vector so client can respond with its diff
        state_vector = await manager.get_state_vector(page_uuid)
        await _send_sync_step1(websocket, state_vector)
    except Exception:
        logger.exception(f"Failed to send initial sync for {page_uuid}")
        await websocket.close(code=4002, reason="Sync failed")
        return

    # 6. Run client reader and pub/sub subscriber concurrently
    client_task = asyncio.create_task(
        _handle_client_loop(websocket, page_uuid, user, manager, can_write)
    )
    pubsub_task = asyncio.create_task(
        _handle_pubsub_loop(websocket, page_uuid, user_uuid)
    )
    awareness_task = asyncio.create_task(
        _handle_awareness_loop(websocket, page_uuid, user_uuid)
    )

    try:
        done, pending = await asyncio.wait(
            [client_task, pubsub_task, awareness_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
    except WebSocketDisconnect:
        logger.debug(f"WebSocket disconnected for page {page_uuid}, user {user_id}")
    except Exception:
        logger.exception(f"WebSocket error for page {page_uuid}, user {user_id}")
    finally:
        for task in (client_task, pubsub_task, awareness_task):
            if not task.done():
                task.cancel()
