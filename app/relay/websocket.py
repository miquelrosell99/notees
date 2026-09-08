"""WebSocket endpoint for real-time relay forwarding."""

from __future__ import annotations

import contextlib
import json

from fastapi import Depends, WebSocket, WebSocketDisconnect, status
from pydantic import ValidationError
from pyrate_limiter import Duration, Limiter, Rate

from app.rate_limit import PerKeyBucketFactory
from app.relay.broadcast import subscribe, unsubscribe
from app.relay.dependencies import (
    get_actor_id_ws,
    get_effective_permission_checker,
    get_relay_service,
    get_workspace_restore_epoch,
)
from app.relay.models import BatchRequest, WsHelloMessage
from app.relay.permissions import PermissionChecker, PermissionDeniedError
from app.relay.service import RelayService

# Per-actor/workspace connection attempts per minute. Generous enough for
# reconnect-with-backoff clients, bounded so the previously unlimited
# endpoint cannot be used for connection churn.
_relay_ws_limiter = Limiter(PerKeyBucketFactory([Rate(60, Duration.MINUTE)]))


async def websocket_endpoint(
    websocket: WebSocket,
    workspace_id: str,
    actor_id: str = Depends(get_actor_id_ws),
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
      Client -> Server:
        { "type": "batch", "envelopes": [...] }
      Server -> Client:
        { "type": "ack", "saved_ids": [...] }
        { "type": "error", "message": "..." }
        { "type": "ops", "protocolVersion": 2, "envelopes": [...],
          "seqs": {envelopeId: seq, ...} }
          — one message per saved batch, broadcast to all subscribers after
          commit, whichever path (HTTP or WS) the batch arrived on
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
    await subscribe(workspace_id, websocket)
    latest_seq = await service.get_latest_seq(workspace_id)
    await websocket.send_text(
        WsHelloMessage(restore_epoch=restore_epoch, latest_seq=latest_seq).model_dump_json(by_alias=True)
    )

    try:
        while True:
            try:
                data = await websocket.receive_json()
            except WebSocketDisconnect:
                break
            except (json.JSONDecodeError, RuntimeError):
                await websocket.send_json({"type": "error", "message": "Malformed JSON"})
                continue

            if not isinstance(data, dict) or data.get("type") != "batch":
                await websocket.send_json({"type": "error", "message": "Expected message type: batch"})
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
        await unsubscribe(workspace_id, websocket)
        with contextlib.suppress(RuntimeError):
            await websocket.close()
