"""WebSocket endpoint for real-time relay forwarding."""

from __future__ import annotations

import contextlib
import json
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, WebSocket, WebSocketDisconnect, status
from pydantic import ValidationError
from pyrate_limiter import Duration, Limiter, Rate

from app.rate_limit import PerKeyBucketFactory
from app.relay.broadcast import broadcast_frame, subscribe, unsubscribe
from app.relay.dependencies import (
    get_actor_id_ws,
    get_effective_permission_checker,
    get_relay_service,
    get_workspace_restore_epoch,
    get_ws_user,
)
from app.relay.models import BatchRequest, WsHelloMessage
from app.relay.permissions import PermissionChecker, PermissionDeniedError
from app.relay.presence import build_presence_user
from app.relay.service import RelayService

# Per-actor/workspace connection attempts per minute. Generous enough for
# reconnect-with-backoff clients, bounded so the previously unlimited
# endpoint cannot be used for connection churn.
_relay_ws_limiter = Limiter(PerKeyBucketFactory([Rate(60, Duration.MINUTE)]))


@dataclass
class _PresenceState:
    """Per-connection presence state (ephemeral, never persisted)."""

    user: dict[str, Any]
    tag: str
    focused_block: str | None = None


# workspace_id -> {websocket: presence state}. Single-process snapshot used for
# users_list and sender exclusion; cross-worker users_list accuracy is out of
# scope (protocol/SPEC.md §5) — presence frames still fan out via Redis.
_presence_connections: dict[str, dict[WebSocket, _PresenceState]] = {}


def _presence_frame(action: str, block_uuid: str, user: dict[str, Any]) -> dict[str, Any]:
    return {"type": "presence", "action": action, "blockUuid": block_uuid, "user": user}


async def _send_presence_users_list(websocket: WebSocket, workspace_id: str) -> None:
    """Send the new connection a snapshot of other users' focused blocks."""
    users = [
        {"user": state.user, "blockUuid": state.focused_block}
        for ws, state in _presence_connections.get(workspace_id, {}).items()
        if ws is not websocket and state.focused_block
    ]
    await websocket.send_json({"type": "presence", "action": "users_list", "users": users})


async def _handle_presence_frame(
    websocket: WebSocket,
    workspace_id: str,
    state: _PresenceState,
    data: dict[str, Any],
) -> None:
    """Handle a client presence frame (focus/blur/typing).

    Focus auto-blurs the connection's previous block; typing is broadcast-only
    (receivers TTL it themselves). Malformed frames get an ``error`` frame.
    """
    action = data.get("action")
    block_uuid = data.get("blockUuid")
    if action not in ("focus", "blur", "typing") or not isinstance(block_uuid, str):
        await websocket.send_json({"type": "error", "message": "Malformed presence frame"})
        return

    if action == "focus":
        if state.focused_block and state.focused_block != block_uuid:
            await broadcast_frame(
                workspace_id,
                _presence_frame("user_blur", state.focused_block, state.user),
                exclude_tag=state.tag,
            )
        state.focused_block = block_uuid
        await broadcast_frame(
            workspace_id,
            _presence_frame("user_focus", block_uuid, state.user),
            exclude_tag=state.tag,
        )
    elif action == "blur":
        if state.focused_block == block_uuid:
            state.focused_block = None
            await broadcast_frame(
                workspace_id,
                _presence_frame("user_blur", block_uuid, state.user),
                exclude_tag=state.tag,
            )
    else:
        await broadcast_frame(
            workspace_id,
            _presence_frame("user_typing", block_uuid, state.user),
            exclude_tag=state.tag,
        )


async def websocket_endpoint(
    websocket: WebSocket,
    workspace_id: str,
    actor_id: str = Depends(get_actor_id_ws),
    user: dict | None = Depends(get_ws_user),
    permissions: PermissionChecker = Depends(get_effective_permission_checker),
    service: RelayService = Depends(get_relay_service),
    restore_epoch: int = Depends(get_workspace_restore_epoch),
) -> None:
    """Accept WebSocket connections and forward relay operation batches.

    Clients must authenticate with the same JWT cookie or Bearer token used by
    the HTTP relay endpoints and have read access to the workspace. Accepted
    connections receive a real-time copy of every operation envelope saved by
    any client in the same workspace.

    Message protocol (JSON):
      Server -> Client (immediately after connect):
        { "type": "hello", "protocolVersion": 2, "restoreEpoch": N,
          "latestSeq": S }
          — S is the highest server-assigned seq for the workspace; clients
          compare it against their stored seq cursor and run HTTP catch-up
          before accepting live ops when they are behind. The subscription is
          active before S is read, so live `ops` frames may arrive before
          hello; clients buffer them and reconcile by their per-envelope
          `seqs` once hello lands.
        { "type": "presence", "action": "users_list", "users": [...] }
          — snapshot of other connected users' focused blocks, right after
          hello (possibly empty).
      Client -> Server:
        { "type": "batch", "envelopes": [...] }
        { "type": "presence", "action": "focus"|"blur"|"typing",
          "blockUuid": "..." }
      Server -> Client:
        { "type": "ack", "saved_ids": [...] }
        { "type": "error", "message": "..." }
        { "type": "ops", "protocolVersion": 2, "envelopes": [...],
          "seqs": {envelopeId: seq, ...} }
          — one message per saved batch, broadcast to all subscribers after
          commit, whichever path (HTTP or WS) the batch arrived on
        { "type": "presence", "action": "user_focus"|"user_blur"|"user_typing",
          "blockUuid": "...", "user": {"id", "name", "color"} }
          — ephemeral presence broadcast to all subscribers except the sender;
          never persisted, never affects the seq cursor
    """
    if actor_id == "anonymous":
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    if not await permissions.can_read(workspace_id, actor_id):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    allowed = await _relay_ws_limiter.try_acquire_async(
        f"relay:ws:{actor_id}:{workspace_id}",
        blocking=False,
    )
    if not allowed:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    # Subscribe BEFORE reading latest_seq: ops committed before the read are
    # covered by hello.latestSeq (client catch-up), ops committed after the
    # read are delivered live because the subscription is already active.
    # Frames may therefore arrive before hello; clients buffer them and
    # reconcile by the per-envelope seqs after the hello lands.
    presence_state = _PresenceState(user=build_presence_user(user, actor_id), tag=uuid.uuid4().hex)
    await subscribe(workspace_id, websocket, tag=presence_state.tag)
    latest_seq = await service.get_latest_seq(workspace_id)
    await websocket.send_text(
        WsHelloMessage(restore_epoch=restore_epoch, latest_seq=latest_seq).model_dump_json(by_alias=True)
    )
    _presence_connections.setdefault(workspace_id, {})[websocket] = presence_state
    await _send_presence_users_list(websocket, workspace_id)

    try:
        while True:
            try:
                data = await websocket.receive_json()
            except WebSocketDisconnect:
                break
            except (json.JSONDecodeError, RuntimeError):
                await websocket.send_json({"type": "error", "message": "Malformed JSON"})
                continue

            if isinstance(data, dict) and data.get("type") == "presence":
                await _handle_presence_frame(websocket, workspace_id, presence_state, data)
                continue

            if not isinstance(data, dict) or data.get("type") != "batch":
                await websocket.send_json({"type": "error", "message": "Expected message type: batch or presence"})
                continue

            try:
                batch = BatchRequest(envelopes=data.get("envelopes", []))
            except ValidationError as exc:
                await websocket.send_json({"type": "error", "message": f"Invalid envelopes: {exc}"})
                continue

            if actor_id == "anonymous":
                await websocket.send_json({"type": "error", "message": "Anonymous write not allowed"})
                continue

            try:
                saved = await service.receive_batch(batch, actor_id)
            except PermissionDeniedError as exc:
                await websocket.send_json({"type": "error", "message": str(exc)})
                continue

            # receive_batch already broadcast the committed batch to all
            # subscribers (including this sender).
            await websocket.send_json({"type": "ack", "saved_ids": [envelope.id for envelope in saved]})
    finally:
        # Drop presence state first; a focused connection broadcasts a final
        # user_blur so peers do not keep a stale indicator.
        connections = _presence_connections.get(workspace_id)
        if connections is not None:
            connections.pop(websocket, None)
            if not connections:
                _presence_connections.pop(workspace_id, None)
        if presence_state.focused_block:
            await broadcast_frame(
                workspace_id,
                _presence_frame("user_blur", presence_state.focused_block, presence_state.user),
                exclude_tag=presence_state.tag,
            )
        await unsubscribe(workspace_id, websocket)
        with contextlib.suppress(RuntimeError):
            await websocket.close()
