"""In-memory transport for local-first sync tests.

Mirrors ``frontend/src/core/transport.ts`` so backend convergence tests can
share the same Mental model: a ``MemoryRelay`` holds envelopes per workspace and
notifies subscribers; ``MemoryTransport`` adapts it to the ``Transport`` port.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable

from app.core.clock import Hlc, compare_hlc
from app.relay.models import RelayEnvelope


class Transport(ABC):
    """Port for pushing and pulling relay operation envelopes."""

    @abstractmethod
    async def send(self, envelope: RelayEnvelope) -> None:
        """Submit one envelope to the relay."""

    @abstractmethod
    async def catch_up(self, after_hlc: Hlc) -> list[RelayEnvelope]:
        """Return envelopes newer than ``after_hlc``."""

    @abstractmethod
    def subscribe(self, callback: Callable[[RelayEnvelope], None]) -> None:
        """Register a callback for envelopes sent to this workspace."""


class MemoryRelay:
    """In-memory relay used by unit tests.

    Envelopes are stored per workspace and forwarded to local subscribers.
    This is intentionally simple: no persistence, no permissions.
    """

    def __init__(self) -> None:
        self._envelopes: dict[str, list[RelayEnvelope]] = {}
        self._subscribers: dict[str, list[Callable[[RelayEnvelope], None]]] = {}

    def send(self, workspace_id: str, envelope: RelayEnvelope) -> None:
        workspace_envelopes = self._envelopes.setdefault(workspace_id, [])
        # Preserve idempotency by id so duplicate sends are no-ops.
        for existing in workspace_envelopes:
            if existing.id == envelope.id:
                return
        workspace_envelopes.append(envelope)
        workspace_envelopes.sort(key=lambda e: (e.hlc.physical, e.hlc.logical, e.id))
        for callback in self._subscribers.get(workspace_id, []):
            callback(envelope)

    def subscribe(
        self,
        workspace_id: str,
        callback: Callable[[RelayEnvelope], None],
    ) -> None:
        self._subscribers.setdefault(workspace_id, []).append(callback)

    def catch_up(self, workspace_id: str, after_hlc: Hlc) -> list[RelayEnvelope]:
        workspace_envelopes = self._envelopes.get(workspace_id, [])
        return [env for env in workspace_envelopes if compare_hlc(env.hlc, after_hlc) > 0]


class MemoryTransport(Transport):
    """Transport adapter backed by a shared ``MemoryRelay``."""

    def __init__(self, relay: MemoryRelay, workspace_id: str) -> None:
        self._relay = relay
        self._workspace_id = workspace_id

    async def send(self, envelope: RelayEnvelope) -> None:
        self._relay.send(self._workspace_id, envelope)

    async def catch_up(self, after_hlc: Hlc) -> list[RelayEnvelope]:
        return self._relay.catch_up(self._workspace_id, after_hlc)

    def subscribe(self, callback: Callable[[RelayEnvelope], None]) -> None:
        self._relay.subscribe(self._workspace_id, callback)


class RelayServiceTransport(Transport):
    """Transport adapter that talks to a ``RelayService`` through ``SqliteRelayStorage``.

    Useful for load tests that want to measure the real catch-up path without
    standing up an HTTP server.
    """

    def __init__(
        self,
        service,
        actor_id: str,
        workspace_id: str,
    ) -> None:
        self._service = service
        self._actor_id = actor_id
        self._workspace_id = workspace_id
        self._after_seq = 0
        self._subscribers: list[Callable[[RelayEnvelope], None]] = []

    async def send(self, envelope: RelayEnvelope) -> None:
        from app.relay.models import BatchRequest

        await self._service.receive_batch(
            BatchRequest(envelopes=[envelope]),
            self._actor_id,
        )
        for callback in self._subscribers:
            callback(envelope)

    async def catch_up(self, after_hlc: Hlc) -> list[RelayEnvelope]:
        # RelayService catch-up is keyed on the server-assigned seq cursor; the
        # Transport port still speaks HLC, so this adapter keeps an internal
        # seq cursor that only advances and ignores ``after_hlc``.
        envelopes = await self._service.catch_up(
            self._workspace_id,
            self._actor_id,
            self._after_seq,
        )
        for envelope in envelopes:
            if envelope.seq is not None and envelope.seq > self._after_seq:
                self._after_seq = envelope.seq
        return envelopes

    def subscribe(self, callback: Callable[[RelayEnvelope], None]) -> None:
        self._subscribers.append(callback)
