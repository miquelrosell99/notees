"""FastAPI router tests for the operation relay."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.clock import Hlc
from app.relay.dependencies import (
    get_effective_permission_checker,
    get_permission_checker,
    get_relay_storage,
    get_workspace_restore_epoch,
)
from app.relay.models import CatchUpRequest, RelayEnvelope
from app.relay.permissions import PermissionChecker, StubPermissionChecker
from app.relay.router import _catch_up_restore_epoch, router
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

    async def _get_restore_epoch(workspace_id: str) -> int:  # noqa: ARG001
        return 0

    async def _get_catch_up_restore_epoch(request: CatchUpRequest) -> int:  # noqa: ARG001
        return 0

    application.include_router(router)
    application.dependency_overrides[get_relay_storage] = _get_storage
    application.dependency_overrides[get_permission_checker] = _get_permissions
    application.dependency_overrides[get_effective_permission_checker] = _get_permissions
    application.dependency_overrides[get_workspace_restore_epoch] = _get_restore_epoch
    application.dependency_overrides[_catch_up_restore_epoch] = _get_catch_up_restore_epoch
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
) -> RelayEnvelope:
    return RelayEnvelope(
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

    async def _get_restore_epoch(workspace_id: str) -> int:  # noqa: ARG001
        return 0

    async def _get_catch_up_restore_epoch(request: CatchUpRequest) -> int:  # noqa: ARG001
        return 0

    application.include_router(router)
    application.dependency_overrides[get_relay_storage] = _get_storage
    application.dependency_overrides[get_permission_checker] = _get_permissions
    application.dependency_overrides[get_effective_permission_checker] = _get_permissions
    application.dependency_overrides[get_workspace_restore_epoch] = _get_restore_epoch
    application.dependency_overrides[_catch_up_restore_epoch] = _get_catch_up_restore_epoch

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


def test_receive_batch_overwrites_client_actor_id(
    client: TestClient,
    storage: RelayStorage,
) -> None:
    """Envelope actor_id is overwritten with the authenticated actor to prevent impersonation."""
    envelope = _envelope("op-1", actor_id="device-actor-1")
    response = client.post(
        "/api/relay/batch",
        json={"envelopes": [envelope.model_dump(by_alias=True, mode="json")]},
        headers={"x-actor-id": "user-actor-1"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["saved_count"] == 1
    assert data["saved_ids"] == ["op-1"]

    saved = storage.get_catch_up("ws-1", 0)
    assert len(saved) == 1
    assert saved[0].actor_id == "user-actor-1"


def test_receive_batch_rejects_cross_workspace_envelopes(client: TestClient) -> None:
    """All envelopes in a batch must belong to the same workspace."""
    first = _envelope("op-1", workspace_id="ws-1")
    second = _envelope("op-2", workspace_id="ws-2")
    response = client.post(
        "/api/relay/batch",
        json={
            "envelopes": [
                first.model_dump(by_alias=True, mode="json"),
                second.model_dump(by_alias=True, mode="json"),
            ]
        },
        headers={"x-actor-id": "actor-1"},
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_catch_up_returns_newer_envelopes(client: TestClient, storage: RelayStorage) -> None:
    service = RelayService(storage, StubPermissionChecker())
    old = _envelope("op-1", physical=1000)
    new = _envelope("op-2", physical=2000)
    await service.receive_batch(type("Batch", (), {"envelopes": [old, new]})(), "actor-1")

    response = client.post(
        "/api/relay/catch-up",
        json={"workspace_id": "ws-1", "after_seq": 1},
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

    async def _get_catch_up_restore_epoch(request: CatchUpRequest) -> int:  # noqa: ARG001
        return 0

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_relay_storage] = lambda: SqliteRelayStorage()
    app.dependency_overrides[get_permission_checker] = lambda: DenyAll()
    app.dependency_overrides[get_effective_permission_checker] = lambda: DenyAll()
    app.dependency_overrides[_catch_up_restore_epoch] = _get_catch_up_restore_epoch
    deny_client = TestClient(app)

    response = deny_client.post(
        "/api/relay/catch-up",
        json={"workspace_id": "ws-1", "after_seq": 0},
        headers={"x-actor-id": "actor-1"},
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_catch_up_paginated_pages_through_envelopes(
    client: TestClient,
    storage: RelayStorage,
) -> None:
    """Paginated catch-up returns pages with has_more and next_after_seq."""
    service = RelayService(storage, StubPermissionChecker())
    envelopes = [_envelope(f"op-{i:02d}", physical=i * 1000) for i in range(1, 11)]
    await service.receive_batch(type("Batch", (), {"envelopes": envelopes})(), "actor-1")

    all_ids: list[str] = []
    after_seq = 0
    page_count = 0
    while page_count < 5:
        payload: dict = {
            "workspace_id": "ws-1",
            "after_seq": after_seq,
            "limit": 3,
        }

        response = client.post(
            "/api/relay/catch-up",
            json=payload,
            headers={"x-actor-id": "actor-1"},
        )
        assert response.status_code == 200
        data = response.json()

        page_ids = [envelope["id"] for envelope in data["envelopes"]]
        all_ids.extend(page_ids)
        # has_more signals a full page; next_after_seq is the cursor to adopt
        # and is also set on the final page so the tail is not re-fetched.
        if data["has_more"]:
            assert data["next_after_seq"] is not None

        if not data["has_more"]:
            break

        after_seq = data["next_after_seq"]
        page_count += 1

    assert all_ids == [f"op-{i:02d}" for i in range(1, 11)]

    # Adopting the final page's cursor must make the next pull a no-op.
    response = client.post(
        "/api/relay/catch-up",
        json={"workspace_id": "ws-1", "after_seq": data["next_after_seq"], "limit": 3},
        headers={"x-actor-id": "actor-1"},
    )
    assert response.status_code == 200
    tail = response.json()
    assert tail["envelopes"] == []
    assert tail["has_more"] is False


def test_snapshot_latest_requires_workspace_id(client: TestClient) -> None:
    """The snapshot endpoint now requires a workspace_id query parameter."""
    response = client.get("/api/relay/snapshot")
    assert response.status_code == 422


def test_snapshot_latest_returns_empty_snapshot_for_missing_workspace(
    client: TestClient,
) -> None:
    """A workspace with no snapshots returns has_snapshot=False."""
    response = client.get(
        "/api/relay/snapshot",
        params={"workspace_id": "00000000-0000-0000-0000-000000000001"},
        headers={"X-Actor-Id": "00000000-0000-0000-0000-000000000002"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["has_snapshot"] is False
