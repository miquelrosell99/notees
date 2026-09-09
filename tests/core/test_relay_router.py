"""FastAPI router tests for the operation relay."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pyrate_limiter import Duration, Limiter, Rate

from app.core.clock import Hlc
from app.rate_limit import PerKeyBucketFactory
from app.relay.dependencies import (
    get_actor_id,
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


def _mount_relay(
    application: FastAPI,
    storage: RelayStorage,
    permissions: PermissionChecker,
    *,
    authenticated_actor: str | None = "actor-1",
) -> FastAPI:
    """Mount the relay router with test doubles.

    ``authenticated_actor`` overrides ``get_actor_id`` to simulate a valid
    authenticated principal; pass ``None`` to keep the production dependency
    (which only trusts real JWT credentials) for security tests.
    """

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
    if authenticated_actor is not None:
        application.dependency_overrides[get_actor_id] = lambda: authenticated_actor
    return application


@pytest.fixture
def app(storage: RelayStorage, permissions: PermissionChecker) -> FastAPI:
    return _mount_relay(FastAPI(), storage, permissions)


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
    application = _mount_relay(FastAPI(), storage, permissions)

    with TestClient(application) as client:
        envelope = _envelope("op-mounted")
        response = client.post(
            "/api/relay/batch",
            json={"envelopes": [envelope.model_dump(by_alias=True, mode="json")]},
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
    )
    assert response.status_code == 200
    data = response.json()
    assert data["saved_count"] == 1
    assert data["saved_ids"] == ["op-1"]


def test_receive_batch_ignores_spoofed_actor_header(
    client: TestClient,
    storage: RelayStorage,
) -> None:
    """A caller-supplied X-Actor-Id header must not override the authenticated principal."""
    envelope = _envelope("op-1", actor_id="device-actor-1")
    response = client.post(
        "/api/relay/batch",
        json={"envelopes": [envelope.model_dump(by_alias=True, mode="json")]},
        headers={"x-actor-id": "attacker-actor"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["saved_count"] == 1
    assert data["saved_ids"] == ["op-1"]

    saved = storage.get_catch_up("ws-1", 0)
    assert len(saved) == 1
    assert saved[0].actor_id == "actor-1"


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
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data["envelopes"]) == 1
    assert data["envelopes"][0]["id"] == "op-2"


def test_catch_up_rejects_permission_denied(
    storage: RelayStorage,
) -> None:
    class DenyAll(PermissionChecker):
        async def can_write(self, workspace_id: str, actor_id: str, affected_node_ids: list[str]) -> bool:
            return False

        async def can_read(self, workspace_id: str, actor_id: str) -> bool:
            return False

    deny_app = _mount_relay(FastAPI(), storage, DenyAll())
    deny_client = TestClient(deny_app)

    response = deny_client.post(
        "/api/relay/catch-up",
        json={"workspace_id": "ws-1", "after_seq": 0},
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
    )
    assert response.status_code == 200
    data = response.json()
    assert data["has_snapshot"] is False


def _seed_snapshot(storage: RelayStorage, workspace_id: str = "ws-1") -> None:
    storage.save_envelope(_envelope("op-snap", workspace_id=workspace_id))
    storage.create_snapshot(workspace_id, Hlc(physical=1000, logical=0), data=b"snapshot-bytes")


def test_snapshot_latest_returns_metadata_only(
    client: TestClient,
    storage: RelayStorage,
) -> None:
    """GET /snapshot serves metadata only; the blob moved to /snapshot/data."""
    _seed_snapshot(storage)

    response = client.get(
        "/api/relay/snapshot",
        params={"workspace_id": "ws-1"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["has_snapshot"] is True
    assert data["snapshot_id"]
    assert data["hlc"] == {"physical": 1000, "logical": 0}
    assert data["up_to_seq"] is not None
    assert "data_base64" not in data


def test_snapshot_data_binary_round_trip(
    client: TestClient,
    storage: RelayStorage,
) -> None:
    """PUT binary upload + GET binary download; 404 when no snapshot exists."""
    missing = client.get("/api/relay/snapshot/data", params={"workspace_id": "ws-missing"})
    assert missing.status_code == 404

    _seed_snapshot(storage)
    response = client.get("/api/relay/snapshot/data", params={"workspace_id": "ws-1"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.content == b"snapshot-bytes"


def _unauthenticated_client(
    storage: RelayStorage,
    permissions: PermissionChecker,
) -> TestClient:
    """Client whose requests carry no valid JWT, hitting the real auth dependency."""
    return TestClient(_mount_relay(FastAPI(), storage, permissions, authenticated_actor=None))


def test_batch_rejects_x_actor_id_without_credentials(
    storage: RelayStorage,
    permissions: PermissionChecker,
) -> None:
    """The X-Actor-Id header alone must not authenticate a batch submission."""
    anon = _unauthenticated_client(storage, permissions)
    envelope = _envelope("op-anon")
    response = anon.post(
        "/api/relay/batch",
        json={"envelopes": [envelope.model_dump(by_alias=True, mode="json")]},
        headers={"x-actor-id": "actor-1"},
    )
    assert response.status_code == 401
    assert storage.get_catch_up("ws-1", 0) == []


def test_catch_up_rejects_x_actor_id_without_credentials(
    storage: RelayStorage,
    permissions: PermissionChecker,
) -> None:
    """The X-Actor-Id header alone must not authenticate a catch-up read."""
    anon = _unauthenticated_client(storage, permissions)
    response = anon.post(
        "/api/relay/catch-up",
        json={"workspace_id": "ws-1", "after_seq": 0},
        headers={"x-actor-id": "actor-1"},
    )
    assert response.status_code == 401


def test_snapshot_rejects_anonymous_share_token(
    storage: RelayStorage,
    permissions: PermissionChecker,
) -> None:
    """Public share tokens are not accepted for full-workspace snapshot reads."""
    _seed_snapshot(storage)
    anon = _unauthenticated_client(storage, permissions)
    response = anon.get(
        "/api/relay/snapshot",
        params={"workspace_id": "ws-1", "share_token": "any-token"},
    )
    assert response.status_code == 401


def test_stats_rejects_anonymous(
    storage: RelayStorage,
    permissions: PermissionChecker,
) -> None:
    anon = _unauthenticated_client(storage, permissions)
    response = anon.get(
        "/api/relay/stats",
        params={"workspace_id": "ws-1"},
        headers={"x-actor-id": "actor-1"},
    )
    assert response.status_code == 401


def test_batch_rate_limit_counts_envelopes_not_requests(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The batch limiter charges per envelope: 2 batches of 3 exceed a 5/min limit."""
    small_limiter = Limiter(PerKeyBucketFactory([Rate(5, Duration.MINUTE)]))
    monkeypatch.setattr("app.relay.router._relay_batch_limiter", small_limiter)

    first = client.post(
        "/api/relay/batch",
        json={"envelopes": [_envelope(f"op-a{i}").model_dump(by_alias=True, mode="json") for i in range(3)]},
    )
    assert first.status_code == 200

    second = client.post(
        "/api/relay/batch",
        json={"envelopes": [_envelope(f"op-b{i}").model_dump(by_alias=True, mode="json") for i in range(3)]},
    )
    assert second.status_code == 429


@pytest.mark.asyncio
async def test_receive_batch_checks_permissions_once_per_batch(
    storage: RelayStorage,
) -> None:
    """The write permission check runs once per batch, not per envelope."""
    batch_calls: list[int] = []

    class CountingChecker(StubPermissionChecker):
        async def can_write_batch(
            self,
            workspace_id: str,
            actor_id: str,
            affected_node_ids_batch: list[list[str]],
        ) -> bool:
            batch_calls.append(len(affected_node_ids_batch))
            return True

    service = RelayService(storage, CountingChecker())
    envelopes = [_envelope(f"op-{i}") for i in range(10)]
    batch = type("Batch", (), {"envelopes": envelopes})()

    saved = await service.receive_batch(batch, "actor-1")

    assert len(saved) == 10
    assert batch_calls == [10]


def test_batch_accepts_encrypted_payloads(client: TestClient) -> None:
    """E2EE payloads ($e marker) skip op-type field validation (SPEC §8)."""
    envelope = _envelope("op-e2ee")
    body = envelope.model_dump(by_alias=True, mode="json")
    # A node.create payload without nodeId/kind would 422 in plaintext;
    # encrypted it is opaque and accepted.
    body["payload"] = {"$e": {"iv": "aXY=", "ct": "Y3Q="}}
    body["protocolVersion"] = 2

    response = client.post("/api/relay/batch", json={"envelopes": [body]})
    assert response.status_code == 200
    assert response.json()["saved_ids"] == ["op-e2ee"]


def test_batch_rejects_malformed_encrypted_marker(client: TestClient) -> None:
    envelope = _envelope("op-e2ee-bad")
    body = envelope.model_dump(by_alias=True, mode="json")
    body["payload"] = {"$e": {"iv": 123, "ct": "Y3Q="}}

    response = client.post("/api/relay/batch", json={"envelopes": [body]})
    assert response.status_code == 422


def test_encryption_key_endpoints(
    storage: RelayStorage,
    permissions: PermissionChecker,
) -> None:
    """GET/PUT round trip; anonymous rejected; members see enabled state."""
    from datetime import UTC, datetime

    from app.dependencies import get_current_user
    from app.models import User

    application = _mount_relay(FastAPI(), storage, permissions)
    application.dependency_overrides[get_current_user] = lambda: User(
        id="1",
        uuid="actor-1",
        email="admin@test",
        role="admin",
        created_at=datetime.now(UTC),
    )
    client = TestClient(application)

    # Anonymous cannot read the record.
    anon = _unauthenticated_client(storage, permissions)
    assert anon.get("/api/relay/encryption-key", params={"workspace_id": "ws-1"}).status_code == 401

    # No record yet → disabled.
    response = client.get("/api/relay/encryption-key", params={"workspace_id": "ws-1"})
    assert response.status_code == 200
    assert response.json() == {"workspaceId": "ws-1", "wrappedKey": None, "enabled": False}

    # Owner/admin stores the wrapped blob; members can read it back.
    put = client.put(
        "/api/relay/encryption-key",
        json={"workspace_id": "ws-1", "wrapped_key": '{"v":1,"salt":"c2FsdA==","wk":"d2s="}'},
    )
    assert put.status_code == 200
    assert put.json()["enabled"] is True

    response = client.get("/api/relay/encryption-key", params={"workspace_id": "ws-1"})
    assert response.status_code == 200
    assert response.json()["wrappedKey"] == '{"v":1,"salt":"c2FsdA==","wk":"d2s="}'
    assert response.json()["enabled"] is True
