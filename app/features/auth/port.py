"""Repository interfaces (ports) for the auth feature."""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.domain.entities import User, UserCreateData


class UserRepository(ABC):
    """Repository interface for User operations and auth persistence.

    This port consolidates user-account persistence together with the
    API-key and refresh-token tables that are logically owned by the
    authentication subsystem. Concrete adapters implement the raw SQL;
    callers in ``app.auth`` build tokens, hashes, and caching on top.
    """

    # ============== User CRUD ==============

    @abstractmethod
    async def create(self, data: UserCreateData, password_hash: str) -> User:
        """Create a new user."""
        pass

    @abstractmethod
    async def get_by_id(self, user_id: int) -> User | None:
        """Get user by ID."""
        pass

    @abstractmethod
    async def get_by_uuid(self, uuid: str) -> User | None:
        """Get user by UUID."""
        pass

    @abstractmethod
    async def get_by_id_or_uuid(self, user_id: str) -> User | None:
        """Get user by ID or UUID string."""
        pass

    @abstractmethod
    async def get_by_email(self, email: str) -> User | None:
        """Get user by email address."""
        pass

    @abstractmethod
    async def get_user_id_by_page_node_uuid(self, node_uuid: str) -> int | None:
        """Get user ID whose user page node has the given UUID."""
        pass

    @abstractmethod
    async def get_user_ids_by_page_node_uuids(self, node_uuids: list[str]) -> dict[str, int | None]:
        """Get user IDs for multiple page-node UUIDs in one query."""
        pass

    @abstractmethod
    async def update_profile(
        self,
        user_id: str,
        name: str | None = None,
        surnames: str | None = None,
        profile_pic: str | None = None,
    ) -> User | None:
        """Update a user's profile fields."""
        pass

    @abstractmethod
    async def update_password_hash(self, user_id: str, password_hash: str) -> User | None:
        """Update a user's password hash and return the updated user."""
        pass

    @abstractmethod
    async def deactivate(self, user_id: int) -> bool:
        """Deactivate a user."""
        pass

    @abstractmethod
    async def count_users(self) -> int:
        """Return the total number of users in the system."""
        pass

    @abstractmethod
    async def count_active_admins(self) -> int:
        """Return the number of active admin users in the system."""
        pass

    @abstractmethod
    async def ensure_initial_admin(self, admin_email: str, admin_password: str) -> bool:
        """Create an initial admin user if no active admin exists.

        Returns True if a new admin was created, False if an admin already exists.
        """
        pass

    # ============== Two-Factor Authentication (TOTP) ==============

    @abstractmethod
    async def set_totp_secret(self, user_id: int, encrypted_secret: str) -> None:
        """Store a pending encrypted TOTP secret for a user. Does not enable 2FA."""
        pass

    @abstractmethod
    async def get_totp_secret(self, user_id: int) -> str | None:
        """Return the encrypted TOTP secret for a user, or None if unset."""
        pass

    @abstractmethod
    async def set_totp_enabled(self, user_id: int, enabled: bool) -> None:
        """Enable or disable TOTP. Sets totp_enabled_at when enabling, clears it when disabling."""
        pass

    @abstractmethod
    async def clear_totp(self, user_id: int) -> None:
        """Disable TOTP, clear the secret, and delete all backup codes for a user."""
        pass

    @abstractmethod
    async def replace_backup_codes(self, user_id: int, code_hashes: list[str]) -> None:
        """Atomically replace all backup codes for a user with the given hashes."""
        pass

    @abstractmethod
    async def get_unused_backup_codes(self, user_id: int) -> list[dict]:
        """Return unused backup-code rows as dicts with keys id and code_hash."""
        pass

    @abstractmethod
    async def mark_backup_code_used(self, code_id: int) -> None:
        """Mark a backup code as used (set used_at = NOW())."""
        pass

    # ============== Admin operations ==============

    @abstractmethod
    async def list_users_paginated(self, page: int, page_size: int) -> tuple[int, list[Any]]:
        """List all users paginated."""
        pass

    @abstractmethod
    async def count_other_admins(self, user_id: int) -> int:
        """Count active admins other than the given user."""
        pass

    @abstractmethod
    async def update_user_admin(self, user_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        """Update a user as admin. Returns the updated user row or None."""
        pass

    @abstractmethod
    async def deactivate_user_admin(self, user_id: str) -> bool:
        """Deactivate a user as admin. Returns True if updated."""
        pass

    @abstractmethod
    async def get_system_metrics(self) -> dict[str, Any]:
        """Get system-wide node/user/workspace/share counts."""
        pass

    @abstractmethod
    async def audit_assets(self, dry_run: bool) -> dict[str, Any]:
        """Audit asset files on disk vs active asset nodes."""
        pass

    # ============== API Keys ==============

    @abstractmethod
    async def create_api_key(
        self,
        user_id: int,
        name: str,
        key_hash: str,
        scopes: list[str],
        key_prefix: str,
        last_4: str,
        expires_at: datetime | None = None,
    ) -> dict:
        """Store a new API key and return the persisted record."""
        pass

    @abstractmethod
    async def list_api_keys(self, user_id: int) -> list[dict]:
        """List all non-revoked API keys for a user."""
        pass

    @abstractmethod
    async def revoke_all_api_keys(self, user_id: int) -> None:
        """Revoke all active API keys for a user."""
        pass

    @abstractmethod
    async def revoke_api_key(self, user_id: int, key_id: str) -> bool:
        """Revoke a single API key. Returns True if a row was updated."""
        pass

    @abstractmethod
    async def regenerate_api_key(
        self,
        user_id: int,
        key_id: str,
        key_hash: str,
        key_prefix: str,
        last_4: str,
    ) -> dict | None:
        """Rotate an existing API key's secret. Returns the updated record or None."""
        pass

    @abstractmethod
    async def find_api_key_candidates(self, key_prefix: str, last_4: str) -> list[dict]:
        """Fetch non-revoked, non-expired API keys matching the prefix/last-4 pair."""
        pass

    @abstractmethod
    async def update_api_key_last_used(self, key_id: int) -> None:
        """Update the last_used_at timestamp for an API key."""
        pass

    # ============== Refresh Tokens ==============

    @abstractmethod
    async def create_refresh_token(
        self,
        user_id: int,
        token_hash: str,
        expires_at: datetime,
        family_id: str,
        remember_me: bool = False,
        last_4: str | None = None,
    ) -> dict:
        """Store a refresh token and return the persisted record."""
        pass

    @abstractmethod
    async def list_active_refresh_tokens(self) -> list[dict]:
        """Fetch all non-revoked, non-expired refresh tokens."""
        pass

    @abstractmethod
    async def find_refresh_token_candidates(self, last_4: str) -> list[dict]:
        """Fetch non-revoked, non-expired refresh tokens matching the last-4 suffix."""
        pass

    @abstractmethod
    async def get_refresh_token_replacement(self, token_id: int) -> int | None:
        """Return the token_id that replaced this token, if any."""
        pass

    @abstractmethod
    async def get_refresh_token_grace_status(self, token_id: int) -> dict | None:
        """Return rotated_at and grace_period_used for a refresh token."""
        pass

    @abstractmethod
    async def mark_refresh_token_grace_used(self, token_id: int) -> None:
        """Mark a refresh token's grace period as consumed."""
        pass

    @abstractmethod
    async def rotate_refresh_token(
        self,
        old_token_id: int,
        token_hash: str,
        expires_at: datetime,
        remember_me: bool = False,
        last_4: str | None = None,
    ) -> dict:
        """Rotate a refresh token: revoke old, create new, link them."""
        pass

    @abstractmethod
    async def revoke_refresh_token_family(self, family_id: str) -> None:
        """Revoke all refresh tokens in a family."""
        pass

    @abstractmethod
    async def revoke_all_user_refresh_tokens(self, user_id: int) -> None:
        """Revoke all refresh tokens for a user."""
        pass

class InviteRepository(ABC):
    """Repository interface for pending-invite acceptance operations."""

    @abstractmethod
    async def get_pending_invite(self, token: str) -> Any | None:
        """Get an active pending invite by its UUID token."""
        pass

    @abstractmethod
    async def expire_invite(self, invite_id: int) -> None:
        """Mark a pending invite as inactive."""
        pass

    @abstractmethod
    async def apply_invite_shares(
        self,
        invite: Any,
        user_id: int,
    ) -> None:
        """Create workspace/node shares from an invite in a single transaction."""
        pass
