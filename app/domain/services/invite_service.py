"""Invite acceptance service."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..repositories.interfaces import InviteRepository


class InviteService:
    """Orchestrates pending-invite acceptance.

    The repository handles the transactional share creation; this service
    coordinates user lookup/creation, expiry checks, and token generation.
    """

    def __init__(self, invite_repo: InviteRepository, auth_module: Any):
        self._invite_repo = invite_repo
        self._auth = auth_module

    async def get_invite(self, token: str) -> Any | None:
        """Return the active invite row or None if not found/expired."""
        return await self._invite_repo.get_pending_invite(token)

    async def expire_invite(self, invite_id: int) -> None:
        """Explicitly expire a pending invite."""
        await self._invite_repo.expire_invite(invite_id)

    async def accept_invite(
        self,
        token: str,
        password: str | None,
        name: str | None,
    ) -> dict:
        """Accept a pending invitation and return the user record.

        Raises:
            ValueError: If the invite is not found.
            HTTPException-friendly errors are not raised here; callers in the
            router translate domain errors to HTTP responses.
        """
        from fastapi import HTTPException

        invite = await self._invite_repo.get_pending_invite(token)
        if not invite:
            raise ValueError("Invite not found or expired")

        if invite["expires_at"] and invite["expires_at"] < datetime.now():
            await self._invite_repo.expire_invite(invite["id"])
            raise ValueError("Invite has expired")

        email = invite["email"]
        existing = await self._auth.get_user_by_email(email)

        if existing:
            user_id = int(existing["id"])
        else:
            is_first = await self._auth.is_first_boot()
            if not self._auth.settings.registration_enabled and not is_first:
                raise HTTPException(status_code=403, detail="Registration is disabled")

            if not password:
                raise HTTPException(status_code=400, detail="Password is required to create account")

            role = "admin" if is_first else "user"
            user = await self._auth.create_user(
                email=email,
                password=password,
                name=name,
                role=role,
            )
            user_id = int(user["id"])

        await self._invite_repo.apply_invite_shares(invite, user_id)

        user_record = await self._auth.get_user_by_id(user_id)
        if not user_record:
            raise RuntimeError("Failed to retrieve user after invite acceptance")

        return user_record
