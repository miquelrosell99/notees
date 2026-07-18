"""Relay service orchestrating storage and permission checks."""

from __future__ import annotations

from app.core.clock import Hlc
from app.relay.models import BatchRequest, CatchUpRequest, EncryptedEnvelope
from app.relay.permissions import PermissionChecker, PermissionDeniedError
from app.relay.storage import RelayStorage


class RelayService:
    """Accept encrypted operation batches and serve catch-up operations."""

    def __init__(
        self,
        storage: RelayStorage,
        permissions: PermissionChecker,
    ) -> None:
        self._storage = storage
        self._permissions = permissions

    async def receive_batch(
        self,
        batch: BatchRequest,
        actor_id: str,
    ) -> list[EncryptedEnvelope]:
        """Validate, permission-check, dedupe, and persist a batch of envelopes.

        Args:
            batch: The encrypted batch submitted by the client.
            actor_id: The authenticated actor making the request.

        Returns:
            The list of envelopes that were actually saved (duplicates excluded).

        Raises:
            PermissionDeniedError: If the actor is not authorized to submit any
                envelope in the batch or if an envelope's ``actor_id`` does not
                match the authenticated actor.
        """
        saved: list[EncryptedEnvelope] = []
        for envelope in batch.envelopes:
            if envelope.actor_id != actor_id:
                raise PermissionDeniedError("Envelope actor_id does not match the authenticated actor")
            if not await self._permissions.can_write(
                envelope.workspace_id,
                actor_id,
                envelope.affected_node_ids,
            ):
                raise PermissionDeniedError(f"Write denied for actor {actor_id} in workspace {envelope.workspace_id}")
            if self._storage.envelope_exists(envelope.id):
                continue
            self._storage.save_envelope(envelope)
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
        return self._storage.get_catch_up(workspace_id, hlc)

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
        return self._storage.get_catch_up_paginated(
            workspace_id,
            hlc,
            limit=limit,
            after_id=after_id,
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
