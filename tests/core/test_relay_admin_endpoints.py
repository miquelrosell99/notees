"""Tests for relay admin/owner endpoints, validation, and rate limiting."""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from app.core.clock import Hlc
from app.relay.models import MAX_BATCH_SIZE, MAX_ENVELOPE_SIZE_BYTES, EncryptedEnvelope

pytestmark = pytest.mark.unit


def _envelope(
    envelope_id: str,
    workspace_id: str,
    actor_id: str | None = None,
    op_type: str = "node.create",
    physical: int = 1000,
    logical: int = 0,
    ciphertext: str = "ZW5jcnlwdGVk",
) -> EncryptedEnvelope:
    return EncryptedEnvelope(
        id=envelope_id,
        workspace_id=workspace_id,
        actor_id=actor_id or "actor-1",
        hlc=Hlc(physical=physical, logical=logical),
        affected_node_ids=["node-1"],
        op_type=op_type,
        ciphertext=ciphertext,
        iv="c3R1Yml2MTIz",
        timestamp="2026-07-17T00:00:00Z",
    )


@pytest.mark.asyncio
async def test_create_snapshot_as_owner(
    auth_client: AsyncClient, test_user: dict
) -> None:
    response = await auth_client.post(
        "/api/relay/snapshot",
        json={
            "workspace_id": test_user["workspace_uuid"],
            "up_to_hlc": {"physical": 100, "logical": 0},
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert "snapshot_id" in data
    assert data["workspace_id"] == test_user["workspace_uuid"]


@pytest.mark.asyncio
async def test_compact_as_owner(
    auth_client: AsyncClient, test_user: dict
) -> None:
    response = await auth_client.post(
        "/api/relay/compact",
        json={
            "workspace_id": test_user["workspace_uuid"],
            "up_to_hlc": {"physical": 100, "logical": 0},
            "prune": False,
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert "snapshot_id" in data
    assert "segment_id" in data
    assert "operation_count" in data


@pytest.mark.asyncio
async def test_snapshot_rejects_unknown_workspace(
    auth_client: AsyncClient, test_user: dict
) -> None:
    response = await auth_client.post(
        "/api/relay/snapshot",
        json={
            "workspace_id": "00000000-0000-0000-0000-000000000000",
            "up_to_hlc": {"physical": 100, "logical": 0},
        },
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_batch_rejects_oversized_envelope(
    auth_client: AsyncClient, test_user: dict
) -> None:
    envelope = _envelope(
        envelope_id="op-big",
        workspace_id=test_user["workspace_uuid"],
        actor_id=test_user["uuid"],
        ciphertext="a" * (MAX_ENVELOPE_SIZE_BYTES + 1),
    )
    response = await auth_client.post(
        "/api/relay/batch",
        json={"envelopes": [envelope.model_dump(by_alias=True, mode="json")]},
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_batch_rejects_too_many_envelopes(
    auth_client: AsyncClient, test_user: dict
) -> None:
    envelopes = [
        _envelope(
            envelope_id=f"op-{i}",
            workspace_id=test_user["workspace_uuid"],
            actor_id=test_user["uuid"],
            physical=i,
        ).model_dump(by_alias=True, mode="json")
        for i in range(MAX_BATCH_SIZE + 1)
    ]
    response = await auth_client.post("/api/relay/batch", json={"envelopes": envelopes})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_batch_includes_rate_limit_headers(
    auth_client: AsyncClient, test_user: dict
) -> None:
    envelope = _envelope(
        envelope_id="op-rate",
        workspace_id=test_user["workspace_uuid"],
        actor_id=test_user["uuid"],
    )
    response = await auth_client.post(
        "/api/relay/batch",
        json={"envelopes": [envelope.model_dump(by_alias=True, mode="json")]},
    )
    assert response.status_code == 200
    assert "x-ratelimit-limit" in {k.lower() for k in response.headers}
