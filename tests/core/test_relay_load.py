"""Load and catch-up performance tests for the encrypted operation relay.

These tests seed a large number of deterministic envelopes into
``SqliteRelayStorage`` and measure the latency of ``RelayService.catch_up``
and paginated catch-up. They also exercise the metric helpers added for
observability.
"""

from __future__ import annotations

import random
import time

import pytest

from app.core.clock import Hlc
from app.relay.models import EncryptedEnvelope
from app.relay.permissions import StubPermissionChecker
from app.relay.service import RelayService
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit

WORKSPACE_ID = "ws-load-test"
ACTOR_ID = "actor-load"
SEED = 42


def _generate_envelopes(
    count: int,
    workspace_id: str = WORKSPACE_ID,
    actor_id: str = ACTOR_ID,
) -> list[EncryptedEnvelope]:
    """Generate ``count`` envelopes with deterministic HLCs and ids."""
    rng = random.Random(SEED)
    envelopes: list[EncryptedEnvelope] = []
    for i in range(count):
        envelope_id = f"env-{workspace_id}-{i:08d}-{rng.randint(0, 1_000_000):06d}"
        physical = (i // 10) + 1
        logical = i % 10
        envelopes.append(
            EncryptedEnvelope(
                id=envelope_id,
                workspace_id=workspace_id,
                actor_id=actor_id,
                hlc=Hlc(physical=physical, logical=logical),
                affected_node_ids=[f"node-{i:08d}"],
                op_type="node.create",
                ciphertext="a" * (rng.randint(64, 256) * 4 // 3),  # base64-ish size
                iv="b" * 16,
            )
        )
    return envelopes


def _seed_storage(storage: SqliteRelayStorage, envelopes: list[EncryptedEnvelope]) -> None:
    for envelope in envelopes:
        storage.save_envelope(envelope)


class TestRelayMetrics:
    def test_count_operations(self) -> None:
        storage = SqliteRelayStorage()
        envelopes = _generate_envelopes(100, workspace_id="ws-metric-count")
        _seed_storage(storage, envelopes)

        assert storage.count_operations("ws-metric-count") == 100
        assert storage.count_operations("ws-missing") == 0

    def test_get_operation_size_estimate(self) -> None:
        storage = SqliteRelayStorage()
        envelopes = _generate_envelopes(10, workspace_id="ws-metric-size")
        _seed_storage(storage, envelopes)

        size = storage.get_operation_size_estimate("ws-metric-size")
        assert size > 0
        # Each envelope has a non-empty ciphertext and iv; total should reflect
        # the sum of their lengths.
        expected = sum(len(env.ciphertext) + len(env.iv) for env in envelopes)
        assert size == expected


class TestRelayCatchUpPerformance:
    @pytest.mark.parametrize("count", [1_000, 10_000])
    @pytest.mark.asyncio
    async def test_catch_up_latency(self, count: int) -> None:
        storage = SqliteRelayStorage()
        envelopes = _generate_envelopes(count)
        _seed_storage(storage, envelopes)
        service = RelayService(storage, StubPermissionChecker())

        start = time.perf_counter()
        results = await service.catch_up(WORKSPACE_ID, ACTOR_ID, Hlc(physical=0, logical=0))
        elapsed = time.perf_counter() - start

        assert len(results) == count
        assert elapsed < 5.0, f"catch_up for {count} ops took {elapsed:.3f}s"
        print(f"catch_up({count}) elapsed: {elapsed:.3f}s")

    @pytest.mark.asyncio
    async def test_catch_up_paginated_counts_and_ordering(self) -> None:
        storage = SqliteRelayStorage()
        count = 10_000
        envelopes = _generate_envelopes(count)
        _seed_storage(storage, envelopes)
        service = RelayService(storage, StubPermissionChecker())

        collected: list[EncryptedEnvelope] = []
        cursor_hlc = Hlc(physical=0, logical=0)
        after_id: str | None = None
        page = 0
        while True:
            page += 1
            results, next_after_id = await service.catch_up_paginated(
                WORKSPACE_ID,
                ACTOR_ID,
                cursor_hlc,
                limit=1_000,
                after_id=after_id,
            )
            assert len(results) <= 1_000
            collected.extend(results)
            if next_after_id is None:
                break
            after_id = next_after_id
            # Advance the HLC cursor to the last envelope of this page so the
            # next page starts after it.
            cursor_hlc = results[-1].hlc
            assert page <= 10, "pagination did not terminate"

        assert len(collected) == count
        # Verify total ordering by HLC then id.
        for prev, curr in zip(collected, collected[1:], strict=False):
            assert (prev.hlc.physical, prev.hlc.logical, prev.id) <= (
                curr.hlc.physical,
                curr.hlc.logical,
                curr.id,
            )

    @pytest.mark.asyncio
    async def test_catch_up_paginated_respects_hlc_cursor(self) -> None:
        storage = SqliteRelayStorage()
        envelopes = _generate_envelopes(2_500)
        _seed_storage(storage, envelopes)
        service = RelayService(storage, StubPermissionChecker())

        # Skip the first 500 envelopes by HLC.
        cursor_hlc = envelopes[499].hlc
        results, next_after_id = await service.catch_up_paginated(
            WORKSPACE_ID,
            ACTOR_ID,
            cursor_hlc,
            limit=1_000,
        )
        assert len(results) == 1_000
        assert next_after_id is not None
        # No result should be before or equal to the cursor HLC.
        for envelope in results:
            assert (envelope.hlc.physical, envelope.hlc.logical) > (
                cursor_hlc.physical,
                cursor_hlc.logical,
            )
