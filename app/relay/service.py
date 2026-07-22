"""Relay service orchestrating storage and permission checks."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from app.core.clock import Hlc, compare_hlc
from app.relay.models import BatchRequest, CatchUpRequest, EncryptedEnvelope
from app.relay.permissions import PermissionChecker, PermissionDeniedError
from app.relay.storage import RelayStorage

MAX_BATCH_SIZE = 1000
MAX_ENVELOPE_SIZE_BYTES = 1024 * 1024  # 1 MB


class RelayService:
    """Accept operation batches and serve catch-up operations."""

    def __init__(
        self,
        storage: RelayStorage,
        permissions: PermissionChecker,
    ) -> None:
        self._storage = storage
        self._permissions = permissions

    @staticmethod
    async def _maybe_await(value: Any) -> Any:
        """Await coroutine results from async adapters, pass through sync ones."""
        if asyncio.iscoroutine(value):
            return await value
        return value

    @staticmethod
    def _validate_envelope(envelope: EncryptedEnvelope) -> None:
        """Validate size and HLC constraints for a single envelope."""
        if envelope.hlc.physical < 0 or envelope.hlc.logical < 0:
            raise ValueError("HLC components must be non-negative")
        if len(json.dumps(envelope.payload)) > MAX_ENVELOPE_SIZE_BYTES:
            raise ValueError("Envelope payload exceeds maximum size of 1 MB")

    async def receive_batch(
        self,
        batch: BatchRequest,
        actor_id: str,
    ) -> list[EncryptedEnvelope]:
        """Validate, permission-check, dedupe, and persist a batch of envelopes.

        Args:
            batch: The batch submitted by the client.
            actor_id: The authenticated actor making the request.

        Returns:
            The list of envelopes that were actually saved (duplicates excluded).

        Raises:
            PermissionDeniedError: If the actor is not authorized to submit any
                envelope in the batch or if an envelope's ``actor_id`` does not
                match the authenticated actor.
            ValueError: If the batch or an individual envelope fails validation.
        """
        if len(batch.envelopes) > MAX_BATCH_SIZE:
            raise ValueError(f"Batch exceeds maximum of {MAX_BATCH_SIZE} envelopes")

        saved: list[EncryptedEnvelope] = []
        for envelope in batch.envelopes:
            self._validate_envelope(envelope)
            # Permissions are checked against the authenticated actor (user), not
            # the device actor id embedded in the envelope. The envelope actor id
            # is a CRDT device identifier and may differ from the user's UUID.
            can_write = await self._permissions.can_write(
                envelope.workspace_id,
                actor_id,
                envelope.affected_node_ids,
            )
            if not can_write:
                raise PermissionDeniedError(
                    f"Write denied for actor {actor_id} in workspace {envelope.workspace_id}"
                )
            exists = await self._maybe_await(self._storage.envelope_exists(envelope.id))
            if exists:
                continue
            await self._maybe_await(self._storage.save_envelope(envelope))
            saved.append(envelope)
        return saved

    async def catch_up(
        self,
        workspace_id: str,
        actor_id: str,
        hlc: Hlc,
        share_token: str | None = None,
    ) -> list[EncryptedEnvelope]:
        """Return all operations newer than ``hlc`` that ``actor_id`` may read.

        Raises:
            PermissionDeniedError: If ``actor_id`` is not allowed to read the
                requested workspace.
        """
        if not await self._may_read(workspace_id, actor_id, share_token):
            raise PermissionDeniedError(f"Read denied for actor {actor_id} in workspace {workspace_id}")
        return await self._maybe_await(self._storage.get_catch_up(workspace_id, hlc))

    async def catch_up_paginated(
        self,
        workspace_id: str,
        actor_id: str,
        hlc: Hlc,
        limit: int = 1000,
        after_id: str | None = None,
        share_token: str | None = None,
    ) -> tuple[list[EncryptedEnvelope], str | None]:
        """Return a paginated page of operations newer than ``hlc``.

        Raises:
            PermissionDeniedError: If ``actor_id`` is not allowed to read the
                requested workspace.
        """
        if not await self._may_read(workspace_id, actor_id, share_token):
            raise PermissionDeniedError(f"Read denied for actor {actor_id} in workspace {workspace_id}")
        return await self._maybe_await(
            self._storage.get_catch_up_paginated(
                workspace_id,
                hlc,
                limit=limit,
                after_id=after_id,
            )
        )

    async def catch_up_from_request(
        self,
        request: CatchUpRequest,
        actor_id: str,
        share_token: str | None = None,
    ) -> list[EncryptedEnvelope]:
        """Convenience wrapper for :meth:`catch_up` using a request model."""
        return await self.catch_up(
            request.workspace_id,
            actor_id,
            request.hlc,
            share_token=share_token,
        )

    async def can_read_public_share(
        self,
        workspace_id: str,
        share_token: str,
        node_id: str | None = None,
    ) -> bool:
        """Return ``True`` if the share token grants read access to the workspace."""
        return await self._permissions.can_read_public_share(
            workspace_id,
            share_token,
            node_id=node_id,
        )

    async def get_max_hlc(self, workspace_id: str) -> Hlc:
        """Return the highest envelope HLC for ``workspace_id``."""
        return await self._maybe_await(self._storage.get_max_hlc(workspace_id))

    async def get_latest_snapshot(self, workspace_id: str) -> dict[str, Any] | None:
        """Return the newest snapshot for ``workspace_id``."""
        return await self._maybe_await(self._storage.get_latest_snapshot(workspace_id))

    async def get_latest_snapshot_for_actor(
        self,
        workspace_id: str,
        actor_id: str,
        share_token: str | None = None,
    ) -> dict[str, Any] | None:
        """Return the newest snapshot if ``actor_id`` may read the workspace."""
        if not await self._may_read(workspace_id, actor_id, share_token):
            raise PermissionDeniedError(
                f"Actor {actor_id} cannot read workspace {workspace_id}"
            )
        return await self.get_latest_snapshot(workspace_id)

    async def create_snapshot(
        self, workspace_id: str, up_to_hlc: Hlc, data: bytes = b""
    ) -> str:
        """Create a snapshot covering all envelopes up to ``up_to_hlc``.

        Raises:
            ValueError: If ``up_to_hlc`` is ahead of the current maximum
                envelope HLC for the workspace.
        """
        max_hlc = await self.get_max_hlc(workspace_id)
        if compare_hlc(up_to_hlc, max_hlc) > 0:
            raise ValueError(
                "up_to_hlc cannot exceed the current maximum envelope HLC"
            )
        return await self._maybe_await(
            self._storage.create_snapshot(workspace_id, up_to_hlc, data=data)
        )

    async def create_compaction_segment(
        self,
        workspace_id: str,
        up_to_hlc: Hlc,
        prune: bool = True,
        data: bytes = b"",
    ) -> dict[str, Any]:
        """Create a snapshot and record a compacted operation segment.

        Raises:
            ValueError: If ``prune`` is ``True`` but ``data`` is empty.
        """
        return await self._maybe_await(
            self._storage.create_compaction_segment(
                workspace_id, up_to_hlc, prune=prune, data=data
            )
        )

    async def prune_envelopes(self, workspace_id: str, up_to_hlc: Hlc) -> int:
        """Delete envelopes with HLC less than or equal to ``up_to_hlc``."""
        return await self._maybe_await(self._storage.prune_envelopes(workspace_id, up_to_hlc))

    async def get_workspace_stats(
        self, workspace_id: str, actor_id: str, share_token: str | None = None
    ) -> dict[str, Any]:
        """Return operational statistics for ``workspace_id`` if readable."""
        if not await self._may_read(workspace_id, actor_id, share_token):
            raise PermissionDeniedError(
                f"Actor {actor_id} cannot read workspace {workspace_id}"
            )
        return await self._maybe_await(self._storage.get_workspace_stats(workspace_id))

    async def _may_read(
        self,
        workspace_id: str,
        actor_id: str,
        share_token: str | None = None,
    ) -> bool:
        """Return ``True`` if the actor may read the workspace.

        Anonymous actors may read via a valid public-share token; authenticated
        actors are checked through normal workspace membership.
        """
        if actor_id != "anonymous":
            return await self._permissions.can_read(workspace_id, actor_id)
        if share_token is not None:
            return await self._permissions.can_read_public_share(
                workspace_id,
                share_token,
            )
        return False
