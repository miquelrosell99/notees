"""FastAPI router tests for the encrypted operation relay."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.clock import Hlc
from app.relay.dependencies import (
    get_effective_permission_checker,
    get_permission_checker,
    get_relay_storage,
)
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
    application.dependency_overrides[get_effective_permission_checker] = _get_permissions
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
        payload={"nodeId": envelope_id, "kind": "page"},
        timestamp="2026-07-17T00:00:00Z",
    )


def test_relay_router_mounted_and_reachable(storage: RelayStorage, permissions: PermissionChecker) -> None:
    """Verify the relay router is reachable via TestClient once mounted."""
    application = FastAPI()

    def _get_storage() -> RelayStorage:
        return storage

    def _get_permissions() -> PermissionChecker:
        return permissions

    application.include_router(router)
    application.dependency_overrides[get_relay_storage] = _get_storage
    application.dependency_overrides[get_permission_checker] = _get_permissions
    application.dependency_overrides[get_effective_permission_checker] = _get_permissions

    with TestClient(application) as client:
        envelope = _envelope("op-mounted")
        response = client.post(
            "/api/relay/batch",
            json={"envelopes": [envelope.model_dump(by_alias=True, mode="json")]},
            headers={"x-actor-id": "actor-1"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["saved_count"] == 1
        assert data["saved_ids"] == ["op-mounted"]


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


@pytest.mark.asyncio
async def test_catch_up_returns_newer_envelopes(client: TestClient, storage: RelayStorage) -> None:
    service = RelayService(storage, StubPermissionChecker())
    old = _envelope("op-1", physical=1000)
    new = _envelope("op-2", physical=2000)
    await service.receive_batch(type("Batch", (), {"envelopes": [old, new]})(), "actor-1")

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
        async def can_write(self, workspace_id: str, actor_id: str, affected_node_ids: list[str]) -> bool:
            return False

        async def can_read(self, workspace_id: str, actor_id: str) -> bool:
            return False

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_relay_storage] = lambda: SqliteRelayStorage()
    app.dependency_overrides[get_permission_checker] = lambda: DenyAll()
    app.dependency_overrides[get_effective_permission_checker] = lambda: DenyAll()
    deny_client = TestClient(app)

    response = deny_client.post(
        "/api/relay/catch-up",
        json={"workspace_id": "ws-1", "hlc": {"physical": 0, "logical": 0}},
        headers={"x-actor-id": "actor-1"},
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_catch_up_paginated_pages_through_envelopes(
    client: TestClient,
    storage: RelayStorage,
) -> None:
    """Paginated catch-up returns pages with has_more and next_after_id."""
    service = RelayService(storage, StubPermissionChecker())
    envelopes = [_envelope(f"op-{i:02d}", physical=i * 1000) for i in range(1, 11)]
    await service.receive_batch(type("Batch", (), {"envelopes": envelopes})(), "actor-1")

    all_ids: list[str] = []
    hlc: dict[str, int] = {"physical": 0, "logical": 0}
    after_id: str | None = None
    page_count = 0
    while page_count < 5:
        payload: dict = {
            "workspace_id": "ws-1",
            "hlc": hlc,
            "limit": 3,
        }
        if after_id is not None:
            payload["after_id"] = after_id

        response = client.post(
            "/api/relay/catch-up",
            json=payload,
            headers={"x-actor-id": "actor-1"},
        )
        assert response.status_code == 200
        data = response.json()

        page_ids = [envelope["id"] for envelope in data["envelopes"]]
        all_ids.extend(page_ids)
        assert data["has_more"] is (data["next_after_id"] is not None)

        if not data["has_more"]:
            break

        last_envelope = data["envelopes"][-1]
        hlc = last_envelope["hlc"]
        after_id = data["next_after_id"]
        assert after_id == page_ids[-1]
        page_count += 1

    assert all_ids == [f"op-{i:02d}" for i in range(1, 11)]


def test_snapshot_returns_not_implemented(client: TestClient) -> None:
    """The snapshot endpoint reserves the route but returns 501."""
    response = client.get("/api/relay/snapshot")
    assert response.status_code == 501
    assert "not implemented" in response.json()["detail"].lower()
