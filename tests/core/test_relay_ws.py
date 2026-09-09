"""WebSocket tests for the operation relay."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.core.clock import Hlc
from app.features import auth as auth_module
from app.relay.broadcast import reset_broadcast_backend
from app.relay.dependencies import (
    get_effective_permission_checker,
    get_permission_checker,
    get_relay_storage,
    get_workspace_restore_epoch,
)
from app.relay.models import RelayEnvelope
from app.relay.permissions import PermissionChecker, StubPermissionChecker
from app.relay.presence import build_presence_user
from app.relay.router import router
from app.relay.storage import RelayStorage, SqliteRelayStorage

pytestmark = pytest.mark.unit


@pytest.fixture
def storage() -> RelayStorage:
    return SqliteRelayStorage()


@pytest.fixture
def permissions() -> PermissionChecker:
    return StubPermissionChecker()


@pytest.fixture
def app(storage: RelayStorage, permissions: PermissionChecker) -> FastAPI:
    application = FastAPI()
    application.include_router(router)
    application.dependency_overrides[get_relay_storage] = lambda: storage
    application.dependency_overrides[get_permission_checker] = lambda: permissions
    application.dependency_overrides[get_effective_permission_checker] = lambda: permissions
    application.dependency_overrides[get_workspace_restore_epoch] = lambda: 0
    return application


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def clear_broadcast_registry() -> None:
    from app.relay import websocket as relay_ws_module

    reset_broadcast_backend()
    relay_ws_module._presence_connections.clear()  # noqa: SLF001
    yield
    reset_broadcast_backend()
    relay_ws_module._presence_connections.clear()  # noqa: SLF001


@pytest.fixture
def auth_patch(monkeypatch: pytest.MonkeyPatch) -> None:
    """Patch JWT validation so a test actor is treated as authenticated."""
    monkeypatch.setattr(
        auth_module,
        "decode_token",
        lambda _token: {"user_id": "actor-1", "email": "actor-1@test"},
    )
    mock_get_user = AsyncMock(return_value={"uuid": "actor-1", "is_active": True})
    monkeypatch.setattr(auth_module, "get_user_by_id", mock_get_user)


def _envelope(
    envelope_id: str,
    workspace_id: str = "ws-1",
    actor_id: str = "actor-1",
    op_type: str = "node.create",
    physical: int = 1000,
    logical: int = 0,
    affected_node_ids: list[str] | None = None,
) -> RelayEnvelope:
    return RelayEnvelope(
        id=envelope_id,
        workspace_id=workspace_id,
        actor_id=actor_id,
        hlc=Hlc(physical=physical, logical=logical),
        affected_node_ids=affected_node_ids or ["node-1"],
        op_type=op_type,
        payload={"nodeId": envelope_id, "kind": "page"},
        timestamp="2026-07-17T00:00:00Z",
    )


def _assert_hello(websocket, latest_seq: int = 0) -> None:
    """Every accepted connection receives the typed hello greeting first."""
    hello = websocket.receive_json()
    assert hello["type"] == "hello"
    assert hello["protocolVersion"] == 2
    assert hello["restoreEpoch"] == 0
    assert hello["latestSeq"] == latest_seq
    # The presence snapshot immediately follows hello.
    users_list = websocket.receive_json()
    assert users_list["type"] == "presence"
    assert users_list["action"] == "users_list"


def test_websocket_connect_with_valid_actor(client: TestClient, auth_patch: None) -> None:
    """A connection with a valid JWT token is accepted and greeted."""
    with client.websocket_connect(
        "/api/relay/ws/ws-1",
        headers={"Authorization": "Bearer valid-token"},
    ) as websocket:
        _assert_hello(websocket)
        websocket.send_json({"type": "batch", "envelopes": []})
        response = websocket.receive_json()
        assert response["type"] == "ack"
        assert response["saved_ids"] == []


def test_websocket_connect_without_auth_is_rejected(client: TestClient) -> None:
    """A connection without a valid JWT cookie/Bearer token is rejected."""
    with pytest.raises(WebSocketDisconnect), client.websocket_connect("/api/relay/ws/ws-1"):
        pass  # pragma: no cover


def test_websocket_hello_carries_latest_seq(
    client: TestClient,
    auth_patch: None,
    storage: RelayStorage,
) -> None:
    """hello.latestSeq is the workspace's highest server-assigned seq, the
    resume cursor clients compare against their stored position."""
    storage.save_envelope(_envelope("op-1", workspace_id="ws-1", physical=1000))
    storage.save_envelope(_envelope("op-2", workspace_id="ws-1", physical=2000))
    storage.save_envelope(_envelope("op-other", workspace_id="ws-2", physical=3000))

    expected = storage.get_latest_seq("ws-1")
    assert expected > 0
    assert storage.get_latest_seq("ws-2") > expected

    with client.websocket_connect(
        "/api/relay/ws/ws-1",
        headers={"Authorization": "Bearer valid-token"},
    ) as websocket:
        _assert_hello(websocket, latest_seq=expected)


def test_websocket_connect_x_actor_id_alone_is_rejected(client: TestClient) -> None:
    """The X-Actor-Id header alone is not accepted by the production dependency."""
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect(
            "/api/relay/ws/ws-1",
            headers={"x-actor-id": "actor-1"},
        ),
    ):
        pass  # pragma: no cover


def test_websocket_connect_permission_denied(monkeypatch: pytest.MonkeyPatch) -> None:
    """A connection is closed when the actor lacks read permission."""

    class DenyAll(PermissionChecker):
        async def can_write(
            self,
            workspace_id: str,
            actor_id: str,
            affected_node_ids: list[str],
        ) -> bool:
            return False

        async def can_read(self, workspace_id: str, actor_id: str) -> bool:
            return False

    monkeypatch.setattr(
        auth_module,
        "decode_token",
        lambda _token: {"user_id": "actor-1", "email": "actor-1@test"},
    )
    mock_get_user = AsyncMock(return_value={"uuid": "actor-1", "is_active": True})
    monkeypatch.setattr(auth_module, "get_user_by_id", mock_get_user)

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_relay_storage] = lambda: SqliteRelayStorage()
    app.dependency_overrides[get_permission_checker] = lambda: DenyAll()
    app.dependency_overrides[get_effective_permission_checker] = lambda: DenyAll()
    app.dependency_overrides[get_workspace_restore_epoch] = lambda: 0

    with (
        TestClient(app) as deny_client,
        pytest.raises(WebSocketDisconnect),
        deny_client.websocket_connect(
            "/api/relay/ws/ws-1",
            headers={"Authorization": "Bearer valid-token"},
        ),
    ):
        pass  # pragma: no cover


def test_websocket_batch_is_broadcast_to_other_client(
    client: TestClient,
    auth_patch: None,
) -> None:
    """Sending a batch over WS stores the envelope and forwards it to peers."""
    envelope = _envelope("op-1", workspace_id="ws-1", actor_id="actor-1")

    with (
        client.websocket_connect(
            "/api/relay/ws/ws-1",
            headers={"Authorization": "Bearer valid-token"},
        ) as sender,
        client.websocket_connect(
            "/api/relay/ws/ws-1",
            headers={"Authorization": "Bearer valid-token"},
        ) as receiver,
    ):
        _assert_hello(sender)
        _assert_hello(receiver)
        sender.send_json(
            {
                "type": "batch",
                "envelopes": [envelope.model_dump(mode="json")],
            }
        )

        # Broadcasts are typed `ops` messages carrying the batch; envelopes
        # inside use the camelCase wire format, same as HTTP. The frame-level
        # `seqs` map carries the server-assigned seq per envelope id.
        received = receiver.receive_json()
        assert received["type"] == "ops"
        assert received["protocolVersion"] == 2
        assert len(received["envelopes"]) == 1
        assert received["envelopes"][0]["id"] == "op-1"
        assert received["envelopes"][0]["workspaceId"] == "ws-1"
        assert received["envelopes"][0]["protocolVersion"] == 1
        assert received["seqs"]["op-1"] > 0

        # Sender also receives the broadcast (idempotently) before the ack.
        broadcast_to_sender = sender.receive_json()
        assert broadcast_to_sender["type"] == "ops"
        assert broadcast_to_sender["envelopes"][0]["id"] == "op-1"

        ack = sender.receive_json()
        assert ack["type"] == "ack"
        assert ack["saved_ids"] == ["op-1"]


def test_http_batch_is_broadcast_to_ws_subscribers(
    client: TestClient,
    auth_patch: None,
) -> None:
    """Ops pushed over HTTP POST /batch are broadcast to WS subscribers.

    The broadcast happens in the service after commit, so the ingest path
    (HTTP or WS) does not matter.
    """
    envelope = _envelope("op-http-1", workspace_id="ws-1", actor_id="actor-1")

    with client.websocket_connect(
        "/api/relay/ws/ws-1",
        headers={"Authorization": "Bearer valid-token"},
    ) as receiver:
        _assert_hello(receiver)

        response = client.post(
            "/api/relay/batch",
            json={"envelopes": [envelope.model_dump(by_alias=True, mode="json")]},
            headers={"Authorization": "Bearer valid-token"},
        )
        assert response.status_code == 200

        received = receiver.receive_json()
        assert received["type"] == "ops"
        assert [e["id"] for e in received["envelopes"]] == ["op-http-1"]
        assert received["seqs"]["op-http-1"] > 0


def test_websocket_malformed_json_is_handled(
    client: TestClient,
    auth_patch: None,
) -> None:
    """Malformed JSON receives an error message and the connection stays open."""
    with client.websocket_connect(
        "/api/relay/ws/ws-1",
        headers={"Authorization": "Bearer valid-token"},
    ) as websocket:
        _assert_hello(websocket)
        websocket.send_text("not valid json")
        response = websocket.receive_json()
        assert response["type"] == "error"
        assert "Malformed JSON" in response["message"]

        # Connection remains usable after the error.
        websocket.send_json({"type": "batch", "envelopes": []})
        ack = websocket.receive_json()
        assert ack["type"] == "ack"


# --- Presence frames (protocol/SPEC.md §5) -----------------------------------

# The auth_patch fixture resolves every token to actor-1 without a users-table
# row, so presence users fall back to the derived default name/color.
_ACTOR_USER = build_presence_user({"uuid": "actor-1", "is_active": True}, "actor-1")


def _connect_ws(client: TestClient):
    return client.websocket_connect(
        "/api/relay/ws/ws-1",
        headers={"Authorization": "Bearer valid-token"},
    )


def test_presence_focus_broadcast_to_other_connection_only(
    client: TestClient,
    auth_patch: None,
) -> None:
    """A focus frame is broadcast to other connections but never echoed back."""
    with _connect_ws(client) as sender, _connect_ws(client) as receiver:
        _assert_hello(sender)
        _assert_hello(receiver)

        sender.send_json({"type": "presence", "action": "focus", "blockUuid": "block-1"})

        frame = receiver.receive_json()
        assert frame == {
            "type": "presence",
            "action": "user_focus",
            "blockUuid": "block-1",
            "user": _ACTOR_USER,
        }

        # The sender's next frame is the ack for a batch, proving no echo.
        sender.send_json({"type": "batch", "envelopes": []})
        ack = sender.receive_json()
        assert ack["type"] == "ack"


def test_presence_second_focus_auto_blurs_previous_block(
    client: TestClient,
    auth_patch: None,
) -> None:
    """Focusing a second block broadcasts user_blur for the previous one."""
    with _connect_ws(client) as sender, _connect_ws(client) as receiver:
        _assert_hello(sender)
        _assert_hello(receiver)

        sender.send_json({"type": "presence", "action": "focus", "blockUuid": "block-1"})
        assert receiver.receive_json()["action"] == "user_focus"

        sender.send_json({"type": "presence", "action": "focus", "blockUuid": "block-2"})
        blur = receiver.receive_json()
        assert blur == {
            "type": "presence",
            "action": "user_blur",
            "blockUuid": "block-1",
            "user": _ACTOR_USER,
        }
        focus = receiver.receive_json()
        assert focus["action"] == "user_focus"
        assert focus["blockUuid"] == "block-2"


def test_presence_disconnect_broadcasts_user_blur(
    client: TestClient,
    auth_patch: None,
) -> None:
    """Dropping a connection with a focused block broadcasts a final blur."""
    with _connect_ws(client) as receiver:
        _assert_hello(receiver)
        with _connect_ws(client) as sender:
            _assert_hello(sender)
            sender.send_json({"type": "presence", "action": "focus", "blockUuid": "block-9"})
            assert receiver.receive_json()["action"] == "user_focus"

        frame = receiver.receive_json()
        assert frame == {
            "type": "presence",
            "action": "user_blur",
            "blockUuid": "block-9",
            "user": _ACTOR_USER,
        }


def test_presence_users_list_sent_after_hello(
    client: TestClient,
    auth_patch: None,
) -> None:
    """A new connection gets a snapshot of other users' focused blocks."""
    with _connect_ws(client) as first:
        _assert_hello(first)
        first.send_json({"type": "presence", "action": "focus", "blockUuid": "block-1"})

        with _connect_ws(client) as second:
            hello = second.receive_json()
            assert hello["type"] == "hello"
            snapshot = second.receive_json()
            assert snapshot == {
                "type": "presence",
                "action": "users_list",
                "users": [{"user": _ACTOR_USER, "blockUuid": "block-1"}],
            }


def test_presence_malformed_frame_gets_error(
    client: TestClient,
    auth_patch: None,
) -> None:
    """Malformed presence frames get an error frame; the connection stays open."""
    with _connect_ws(client) as websocket:
        _assert_hello(websocket)

        websocket.send_json({"type": "presence", "action": "dance", "blockUuid": "block-1"})
        response = websocket.receive_json()
        assert response["type"] == "error"
        assert "presence" in response["message"]

        websocket.send_json({"type": "presence", "action": "focus"})
        assert websocket.receive_json()["type"] == "error"

        # Connection remains usable for both presence and batch frames.
        websocket.send_json({"type": "presence", "action": "typing", "blockUuid": "block-1"})
        websocket.send_json({"type": "batch", "envelopes": []})
        assert websocket.receive_json()["type"] == "ack"
