"""FastAPI router tests for the encrypted operation relay."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.clock import Hlc
from app.relay.dependencies import get_permission_checker, get_relay_storage
from app.relay.models import EncryptedEnvelope
from app.relay.permissions import PermissionChecker, StubPermissionChecker
from app.relay.router import router
from app.relay.service import RelayService
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

    def _get_storage() -> RelayStorage:
        return storage

    def _get_permissions() -> PermissionChecker:
        return permissions

    application.include_router(router)
    application.dependency_overrides[get_relay_storage] = _get_storage
    application.dependency_overrides[get_permission_checker] = _get_permissions
    return application


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


def _envelope(
    envelope_id: str,
    workspace_id: str = "ws-1",
    actor_id: str = "actor-1",
    op_type: str = "node.create",
    physical: int = 1000,
    logical: int = 0,
) -> EncryptedEnvelope:
    return EncryptedEnvelope(
        id=envelope_id,
        workspace_id=workspace_id,
        actor_id=actor_id,
        hlc=Hlc(physical=physical, logical=logical),
        affected_node_ids=["node-1"],
        op_type=op_type,
        encrypted_payload=b"encrypted",
        timestamp="2026-07-17T00:00:00Z",
    )


def test_receive_batch(client: TestClient) -> None:
    envelope = _envelope("op-1")
    response = client.post(
        "/api/relay/batch",
        json={"envelopes": [envelope.model_dump(by_alias=True, mode="json")]},
        headers={"x-actor-id": "actor-1"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["saved_count"] == 1
    assert data["saved_ids"] == ["op-1"]


def test_receive_batch_rejects_actor_mismatch(client: TestClient) -> None:
    envelope = _envelope("op-1", actor_id="actor-2")
    response = client.post(
        "/api/relay/batch",
        json={"envelopes": [envelope.model_dump(by_alias=True, mode="json")]},
        headers={"x-actor-id": "actor-1"},
    )
    assert response.status_code == 403


def test_catch_up_returns_newer_envelopes(client: TestClient, storage: RelayStorage) -> None:
    service = RelayService(storage, StubPermissionChecker())
    old = _envelope("op-1", physical=1000)
    new = _envelope("op-2", physical=2000)
    service.receive_batch(type("Batch", (), {"envelopes": [old, new]})(), "actor-1")

    response = client.post(
        "/api/relay/catch-up",
        json={"workspace_id": "ws-1", "hlc": {"physical": 1500, "logical": 0}},
        headers={"x-actor-id": "actor-1"},
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data["envelopes"]) == 1
    assert data["envelopes"][0]["id"] == "op-2"


def test_catch_up_rejects_permission_denied(client: TestClient, permissions: PermissionChecker) -> None:
    class DenyAll(PermissionChecker):
        def can_write(self, workspace_id: str, actor_id: str, affected_node_ids: list[str]) -> bool:
            return False

        def can_read(self, workspace_id: str, actor_id: str) -> bool:
            return False

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_relay_storage] = lambda: SqliteRelayStorage()
    app.dependency_overrides[get_permission_checker] = lambda: DenyAll()
    deny_client = TestClient(app)

    response = deny_client.post(
        "/api/relay/catch-up",
        json={"workspace_id": "ws-1", "hlc": {"physical": 0, "logical": 0}},
        headers={"x-actor-id": "actor-1"},
    )
    assert response.status_code == 403
