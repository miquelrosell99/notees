"""WebSocket tests for the encrypted operation relay."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.core.clock import Hlc
from app.features import auth as auth_module
from app.relay.broadcast import _registry as broadcast_registry
from app.relay.dependencies import (
    get_effective_permission_checker,
    get_permission_checker,
    get_relay_storage,
)
from app.relay.models import EncryptedEnvelope
from app.relay.permissions import PermissionChecker, StubPermissionChecker
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
    return application


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def clear_broadcast_registry() -> None:
    broadcast_registry.clear()
    yield
    broadcast_registry.clear()


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
) -> EncryptedEnvelope:
    return EncryptedEnvelope(
        id=envelope_id,
        workspace_id=workspace_id,
        actor_id=actor_id,
        hlc=Hlc(physical=physical, logical=logical),
        affected_node_ids=affected_node_ids or ["node-1"],
        op_type=op_type,
        payload={"nodeId": envelope_id},
        timestamp="2026-07-17T00:00:00Z",
    )


def test_websocket_connect_with_valid_actor(client: TestClient, auth_patch: None) -> None:
    """A connection with a valid JWT token is accepted."""
    with client.websocket_connect(
        "/api/relay/ws/ws-1",
        headers={"Authorization": "Bearer valid-token"},
    ) as websocket:
        websocket.send_json({"type": "batch", "envelopes": []})
        response = websocket.receive_json()
        assert response["type"] == "ack"
        assert response["saved_ids"] == []


def test_websocket_connect_without_auth_is_rejected(client: TestClient) -> None:
    """A connection without a valid JWT cookie/Bearer token is rejected."""
    with pytest.raises(WebSocketDisconnect), client.websocket_connect(
        "/api/relay/ws/ws-1"
    ):
        pass  # pragma: no cover


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

    with TestClient(app) as deny_client, pytest.raises(
        WebSocketDisconnect
    ), deny_client.websocket_connect(
        "/api/relay/ws/ws-1",
        headers={"Authorization": "Bearer valid-token"},
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
        sender.send_json(
            {
                "type": "batch",
                "envelopes": [envelope.model_dump(mode="json")],
            }
        )

        received = receiver.receive_json()
        assert received["id"] == "op-1"
        assert received["workspace_id"] == "ws-1"

        # Sender also receives the broadcast (idempotently) before the ack.
        broadcast_to_sender = sender.receive_json()
        assert broadcast_to_sender["id"] == "op-1"

        ack = sender.receive_json()
        assert ack["type"] == "ack"
        assert ack["saved_ids"] == ["op-1"]


def test_websocket_malformed_json_is_handled(
    client: TestClient,
    auth_patch: None,
) -> None:
    """Malformed JSON receives an error message and the connection stays open."""
    with client.websocket_connect(
        "/api/relay/ws/ws-1",
        headers={"Authorization": "Bearer valid-token"},
    ) as websocket:
        websocket.send_text("not valid json")
        response = websocket.receive_json()
        assert response["type"] == "error"
        assert "Malformed JSON" in response["message"]

        # Connection remains usable after the error.
        websocket.send_json({"type": "batch", "envelopes": []})
        ack = websocket.receive_json()
        assert ack["type"] == "ack"
