"""Stress tests for multi-client convergence under operation bursts.

Multiple independent WorkspaceStore instances generate operations while
disconnected, then sync through a shared in-memory relay and must converge to
identical derived state.
"""

from __future__ import annotations

import os
import time

import pytest

from app.core.clock import Hlc
from app.core.sync import SyncEngine
from app.core.transport import MemoryRelay, MemoryTransport
from app.core.workspace_store import WorkspaceStore
from app.relay.storage import SqliteRelayStorage
from tests.core.fakes import FakeKeyStorage

pytestmark = [pytest.mark.unit, pytest.mark.stress]


def _burst_size() -> int:
    """Number of operations each client emits during a burst."""
    default = 200
    env = os.environ.get("NOTEES_STRESS_BURST_OPS")
    if env:
        return int(env)
    return default


def _client_count() -> int:
    """Number of clients participating in the burst."""
    default = 4
    env = os.environ.get("NOTEES_STRESS_CLIENTS")
    if env:
        return int(env)
    return default


def _install_deterministic_clock(*stores: WorkspaceStore) -> None:
    """Patch stores to use deterministic HLCs across clients."""
    from app.core.clock import max_hlc

    counter = {"physical": 1}
    base = {store.actor_id: 1000 * (i + 1) for i, store in enumerate(stores)}

    def _advance(store: WorkspaceStore) -> Hlc:
        counter["physical"] += 1
        phys = base[store.actor_id] + counter["physical"]
        return store._clock.advance(phys)  # noqa: SLF001

    def _update(store, received, physical_time):  # noqa: ARG001
        store._clock._last = max_hlc(store._clock._last, received)  # noqa: SLF001
        return store._clock._last  # noqa: SLF001

    for store in stores:
        store._advance_clock = lambda s=store: _advance(s)  # noqa: SLF001
        store._clock.update = lambda r, p, s=store: _update(s, r, p)  # noqa: SLF001


class TestMultiClientConvergenceBurst:
    async def test_burst_then_converge(self) -> None:
        """Multiple clients burst ops, sync, and end with identical node sets."""
        client_count = _client_count()
        burst_size = _burst_size()
        workspace_id = "ws-convergence-burst"
        relay = MemoryRelay()

        clients: list[WorkspaceStore] = []
        syncs: list[SyncEngine] = []
        for i in range(client_count):
            store = WorkspaceStore(
                workspace_id=workspace_id,
                actor_id=f"actor-{i}",
                db_path=":memory:",
                relay_storage=SqliteRelayStorage(":memory:"),
                key_storage=FakeKeyStorage(),
            )
            clients.append(store)
            syncs.append(SyncEngine(store, MemoryTransport(relay, workspace_id)))

        _install_deterministic_clock(*clients)

        start = time.perf_counter()
        # Each client creates burst_size nodes while disconnected.
        for i, store in enumerate(clients):
            for j in range(burst_size):
                await store.create_node(f"actor{i}-node-{j:04d}", kind="block")

        # Sync rounds: push all clients, then pull all clients, repeat once.
        for sync in syncs:
            await sync.push()
        for sync in syncs:
            await sync.pull()
        for sync in syncs:
            await sync.push()
        for sync in syncs:
            await sync.pull()
        elapsed = time.perf_counter() - start

        total_ops = client_count * burst_size
        print(
            f"convergence_burst({client_count} clients x {burst_size} ops): "
            f"{elapsed:.3f}s"
        )

        expected_nodes = {
            f"actor{i}-node-{j:04d}"
            for i in range(client_count)
            for j in range(burst_size)
        }

        first_nodes = {row["id"] for row in await clients[0].list_nodes()}
        assert first_nodes == expected_nodes, (
            f"Client 0 has {len(first_nodes)} nodes, expected {len(expected_nodes)}"
        )

        for store in clients[1:]:
            nodes = {row["id"] for row in await store.list_nodes()}
            assert nodes == first_nodes, (
                f"Client node set mismatch: {len(nodes)} vs {len(first_nodes)}"
            )

        assert elapsed < max(5.0, total_ops / 400), (
            f"Burst convergence for {total_ops} ops took {elapsed:.3f}s"
        )

        for store in clients:
            await store.close()
