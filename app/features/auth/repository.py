"""PostgreSQL implementation of User repository.

Updated for workspace-based schema:
- The ``"user"`` table uses ``email`` as the login identifier.
- Profile fields (name, surnames, profile_pic, role) are stored alongside the
  core account columns.
- API-key and refresh-token persistence live here because they are logically
  owned by the authentication subsystem.
"""

from __future__ import annotations

import shutil
from datetime import datetime
from typing import Any

import asyncpg

from app.core.workspace_store import WorkspaceStore
from app.db.connection import acquire_connection, get_data_dir
from app.domain.entities import User, UserCreateData, generate_uuid
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS
from app.domain.repositories.base import BasePostgresRepository, normalize_timestamp
from app.features.auth.port import InviteRepository, UserRepository
from app.logging_config import get_logger
from app.utils import utc_now

logger = get_logger(__name__)


class PostgresUserRepository(UserRepository):
    """PostgreSQL implementation of the UserRepository.

    Updated for new schema:
    - ``username`` -> ``email``
    - ``is_active`` -> ``active``
    """

    def __init__(self, pool: asyncpg.Pool):
        """Initialize with connection pool."""
        self._pool = pool

    def _row_to_user(self, row: asyncpg.Record) -> User:
        """Convert database row to User entity."""
        create_date = normalize_timestamp(row["create_date"])
        write_date = normalize_timestamp(row["write_date"])

        return User(
            id=row["id"],
            uuid=str(row["uuid"]),
            email=row["email"],
            password_hash=row["password_hash"],
            name=row.get("name"),
            surnames=row.get("surnames"),
            profile_pic=row.get("profile_pic"),
            role=row.get("role") or "user",
            active=row["active"],  # Changed from is_active
            totp_enabled=bool(row.get("totp_enabled", False)),
            create_date=create_date,
            write_date=write_date,
        )

    async def create(self, data: UserCreateData, password_hash: str) -> User:
        """Create a new user."""
        now = utc_now()
        uuid = generate_uuid()

        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO "user" (
                    uuid, email, password_hash, name, surnames,
                    profile_pic, role, active, create_date, write_date
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $8)
                RETURNING *
                """,
                uuid,
                data.email,
                password_hash,
                data.name,
                data.surnames,
                data.profile_pic,
                data.role,
                now,
            )

            if row is None:
                raise RuntimeError("Failed to create user - no row returned")
            return self._row_to_user(row)

    async def get_by_id(self, user_id: int) -> User | None:
        """Get user by ID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow('SELECT * FROM "user" WHERE id = $1', user_id)
            return self._row_to_user(row) if row else None

    async def get_by_uuid(self, uuid: str) -> User | None:
        """Get user by UUID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow('SELECT * FROM "user" WHERE uuid = $1', uuid)
            return self._row_to_user(row) if row else None

    async def get_by_id_or_uuid(self, user_id: str) -> User | None:
        """Get user by ID or UUID string."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                'SELECT * FROM "user" WHERE id::text = $1 OR uuid::text = $1',
                user_id,
            )
            return self._row_to_user(row) if row else None

    async def get_by_email(self, email: str) -> User | None:
        """Get user by email."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow('SELECT * FROM "user" WHERE email = $1', email)
            return self._row_to_user(row) if row else None

    async def _primary_workspace_uuid_for_user(
        self, conn: asyncpg.Connection, user_id: int
    ) -> str | None:
        """Return the UUID of the user's primary workspace, or None."""
        row = await conn.fetchrow(
            """
            SELECT w.uuid::text AS workspace_uuid
            FROM workspace w
            WHERE w.create_uid = $1 AND w.active = TRUE
            ORDER BY w.create_date ASC
            LIMIT 1
            """,
            user_id,
        )
        if row:
            return row["workspace_uuid"]
        row = await conn.fetchrow(
            """
            SELECT w.uuid::text AS workspace_uuid
            FROM workspace w
            JOIN workspace_share ws ON w.id = ws.workspace_id
            WHERE ws.user_id = $1 AND ws.active = TRUE AND ws.can_read = TRUE AND w.active = TRUE
            ORDER BY w.create_date ASC
            LIMIT 1
            """,
            user_id,
        )
        return row["workspace_uuid"] if row else None

    async def get_user_id_by_page_node_uuid(self, node_uuid: str) -> int | None:
        """Get user ID whose user page node has the given UUID.

        Without a ``user_page_node_uuid`` column on the ``user`` table, we sync
        each user's primary workspace store and check whether the node exists in
        the derived state.
        """
        from app.relay.dependencies import get_relay_storage

        async with acquire_connection(self._pool) as conn:
            users = await conn.fetch('SELECT id, uuid FROM "user" WHERE active = TRUE')
            for user_row in users:
                workspace_uuid = await self._primary_workspace_uuid_for_user(conn, user_row["id"])
                if not workspace_uuid:
                    continue
                store = WorkspaceStore(
                    workspace_id=workspace_uuid,
                    actor_id=str(user_row["uuid"]),
                    relay_storage=get_relay_storage(),
                )
                try:
                    await store.sync()
                    rows = await store.query(
                        "SELECT 1 FROM node WHERE id = ?",
                        (node_uuid,),
                    )
                    if rows:
                        return user_row["id"]
                finally:
                    await store.close()
            return None

    async def get_user_ids_by_page_node_uuids(self, node_uuids: list[str]) -> dict[str, int | None]:
        """Get user IDs for multiple page-node UUIDs in one query."""
        from app.relay.dependencies import get_relay_storage

        if not node_uuids:
            return {}

        result: dict[str, int | None] = dict.fromkeys(node_uuids, None)
        async with acquire_connection(self._pool) as conn:
            users = await conn.fetch('SELECT id, uuid FROM "user" WHERE active = TRUE')
            for user_row in users:
                workspace_uuid = await self._primary_workspace_uuid_for_user(conn, user_row["id"])
                if not workspace_uuid:
                    continue
                store = WorkspaceStore(
                    workspace_id=workspace_uuid,
                    actor_id=str(user_row["uuid"]),
                    relay_storage=get_relay_storage(),
                )
                try:
                    await store.sync()
                    placeholders = ",".join("?" for _ in node_uuids)
                    rows = await store.query(
                        f"SELECT id FROM node WHERE id IN ({placeholders})",
                        tuple(node_uuids),
                    )
                    for row in rows:
                        node_id = row["id"]
                        if node_id in result and result[node_id] is None:
                            result[node_id] = user_row["id"]
                finally:
                    await store.close()
            return result

    async def update_profile(
        self,
        user_id: str,
        name: str | None = None,
        surnames: str | None = None,
        profile_pic: str | None = None,
    ) -> User | None:
        """Update a user's profile fields."""
        allowed = {"name": name, "surnames": surnames, "profile_pic": profile_pic}
        updates = {k: v for k, v in allowed.items() if v is not None}
        if not updates:
            return await self.get_by_id_or_uuid(user_id)

        set_clauses = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(updates))
        values = list(updates.values())

        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                f"""
                UPDATE "user" SET {set_clauses}, write_date = NOW()
                WHERE id::text = $1 OR uuid::text = $1
                RETURNING *
                """,
                user_id,
                *values,
            )
            return self._row_to_user(row) if row else None

    async def update_password_hash(self, user_id: str, password_hash: str) -> User | None:
        """Update a user's password hash and return the updated user."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                UPDATE "user"
                SET password_hash = $2, write_date = NOW()
                WHERE id::text = $1 OR uuid::text = $1
                RETURNING *
                """,
                user_id,
                password_hash,
            )
            return self._row_to_user(row) if row else None

    async def deactivate(self, user_id: int) -> bool:
        """Deactivate a user (soft delete)."""
        now = utc_now()
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                """
                UPDATE "user"
                SET active = FALSE, write_date = $1
                WHERE id = $2
                """,
                now,
                user_id,
            )
            return result == "UPDATE 1"

    async def count_users(self) -> int:
        """Return the total number of users."""
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchval('SELECT COUNT(*) FROM "user"') or 0

    async def count_active_admins(self) -> int:
        """Return the number of active admin users."""
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchval(
                'SELECT COUNT(*) FROM "user" WHERE role = \'admin\' AND active = TRUE'
            ) or 0

    async def ensure_initial_admin(self, admin_email: str, admin_password: str) -> bool:
        """Create an initial admin user if no active admin exists.

        Returns True if a new admin was created, False if an admin already exists.
        The password is hashed with the application's primary password scheme.
        """
        from ...utils.password import hash_password

        async with acquire_connection(self._pool) as conn:
            admin_count = await conn.fetchval(
                'SELECT COUNT(*) FROM "user" WHERE role = \'admin\' AND active = TRUE'
            )
            if admin_count:
                return False

            now = utc_now()
            uuid = generate_uuid()
            password_hash = hash_password(admin_password)
            row = await conn.fetchrow(
                """
                INSERT INTO "user" (
                    uuid, email, password_hash, name, surnames,
                    profile_pic, role, active, create_date, write_date
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $8)
                RETURNING id
                """,
                uuid,
                admin_email,
                password_hash,
                "Admin",
                None,
                None,
                "admin",
                now,
            )
            return row is not None

    async def get_password_hash(self, user_id: int) -> str | None:
        """Get the password hash for a user."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow('SELECT password_hash FROM "user" WHERE id = $1', user_id)
            return row["password_hash"] if row else None

    # ============== Two-Factor Authentication (TOTP) ==============

    async def set_totp_secret(self, user_id: int, encrypted_secret: str) -> None:
        """Store a pending encrypted TOTP secret for a user. Does not enable 2FA."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                'UPDATE "user" SET totp_secret = $2, write_date = NOW() WHERE id = $1',
                user_id,
                encrypted_secret,
            )

    async def get_totp_secret(self, user_id: int) -> str | None:
        """Return the encrypted TOTP secret for a user, or None if unset."""
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchval(
                'SELECT totp_secret FROM "user" WHERE id = $1',
                user_id,
            )

    async def set_totp_enabled(self, user_id: int, enabled: bool) -> None:
        """Enable or disable TOTP. Sets totp_enabled_at when enabling, clears it when disabling."""
        async with acquire_connection(self._pool) as conn:
            if enabled:
                await conn.execute(
                    'UPDATE "user" SET totp_enabled = TRUE, totp_enabled_at = NOW(), write_date = NOW() WHERE id = $1',
                    user_id,
                )
            else:
                await conn.execute(
                    'UPDATE "user" SET totp_enabled = FALSE, totp_enabled_at = NULL, write_date = NOW() WHERE id = $1',
                    user_id,
                )

    async def clear_totp(self, user_id: int) -> None:
        """Disable TOTP, clear the secret, and delete all backup codes for a user."""
        async with acquire_connection(self._pool) as conn, conn.transaction():
            await conn.execute(
                'UPDATE "user" SET totp_enabled = FALSE, totp_secret = NULL, totp_enabled_at = NULL, write_date = NOW() WHERE id = $1',
                user_id,
            )
            await conn.execute(
                "DELETE FROM user_backup_code WHERE user_id = $1",
                user_id,
            )

    async def replace_backup_codes(self, user_id: int, code_hashes: list[str]) -> None:
        """Atomically replace all backup codes for a user with the given hashes."""
        async with acquire_connection(self._pool) as conn, conn.transaction():
            await conn.execute(
                "DELETE FROM user_backup_code WHERE user_id = $1",
                user_id,
            )
            for code_hash in code_hashes:
                await conn.execute(
                    "INSERT INTO user_backup_code (user_id, code_hash, created_at) VALUES ($1, $2, NOW())",
                    user_id,
                    code_hash,
                )

    async def get_unused_backup_codes(self, user_id: int) -> list[dict]:
        """Return unused backup-code rows as dicts with keys id and code_hash."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT id, code_hash FROM user_backup_code WHERE user_id = $1 AND used_at IS NULL ORDER BY id",
                user_id,
            )
            return [{"id": row["id"], "code_hash": row["code_hash"]} for row in rows]

    async def mark_backup_code_used(self, code_id: int) -> None:
        """Mark a backup code as used (set used_at = NOW())."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "UPDATE user_backup_code SET used_at = NOW() WHERE id = $1",
                code_id,
            )

    # ============== API Keys ==============

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
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO api_key (user_id, name, key_hash, scopes, key_prefix, last_4, expires_at)
                VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
                RETURNING id, uuid, name, scopes, key_prefix, last_4, revoked, create_date, expires_at
                """,
                user_id,
                name,
                key_hash,
                scopes,
                key_prefix,
                last_4,
                expires_at,
            )
            if row is None:
                raise RuntimeError("Failed to create API key")

            return {
                "id": str(row["id"]),
                "uuid": str(row["uuid"]),
                "name": row["name"],
                "scopes": row["scopes"],
                "last_4": row["last_4"],
                "revoked": row["revoked"],
                "created_at": row["create_date"].isoformat() if row["create_date"] else None,
                "expires_at": row["expires_at"].isoformat() if row["expires_at"] else None,
            }

    async def list_api_keys(self, user_id: int) -> list[dict]:
        """List all non-revoked API keys for a user."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, uuid, name, scopes, last_4, last_used_at, revoked, create_date, expires_at
                FROM api_key
                WHERE user_id = $1 AND revoked = FALSE
                ORDER BY create_date DESC
                """,
                user_id,
            )
            return [
                {
                    "id": str(row["id"]),
                    "uuid": str(row["uuid"]),
                    "name": row["name"],
                    "scopes": row["scopes"],
                    "last_4": row["last_4"],
                    "last_used_at": row["last_used_at"].isoformat() if row["last_used_at"] else None,
                    "revoked": row["revoked"],
                    "created_at": row["create_date"].isoformat() if row["create_date"] else None,
                    "expires_at": row["expires_at"].isoformat() if row["expires_at"] else None,
                }
                for row in rows
            ]

    async def revoke_all_api_keys(self, user_id: int) -> None:
        """Revoke all API keys for a user."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                UPDATE api_key
                SET revoked = TRUE, write_date = NOW()
                WHERE user_id = $1 AND revoked = FALSE
                """,
                user_id,
            )

    async def revoke_api_key(self, user_id: int, key_id: str) -> bool:
        """Revoke an API key. Returns True if the key existed and belonged to the user."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                """
                UPDATE api_key SET revoked = TRUE, write_date = NOW()
                WHERE id::text = $1 AND user_id = $2 AND revoked = FALSE
                """,
                key_id,
                user_id,
            )
            return result.startswith("UPDATE 1")

    async def regenerate_api_key(
        self,
        user_id: int,
        key_id: str,
        key_hash: str,
        key_prefix: str,
        last_4: str,
    ) -> dict | None:
        """Rotate an API key's secret in place, preserving name and scopes."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                UPDATE api_key
                SET key_hash = $3,
                    key_prefix = $4,
                    last_4 = $5,
                    write_date = NOW(),
                    last_used_at = NULL
                WHERE id::text = $1 AND user_id = $2 AND revoked = FALSE
                RETURNING id, uuid, name, scopes, key_prefix, last_4, revoked, create_date, expires_at
                """,
                key_id,
                user_id,
                key_hash,
                key_prefix,
                last_4,
            )
            if row is None:
                return None

            return {
                "id": str(row["id"]),
                "uuid": str(row["uuid"]),
                "name": row["name"],
                "scopes": row["scopes"],
                "last_4": row["last_4"],
                "revoked": row["revoked"],
                "created_at": row["create_date"].isoformat() if row["create_date"] else None,
                "expires_at": row["expires_at"].isoformat() if row["expires_at"] else None,
            }

    async def find_api_key_candidates(self, key_prefix: str, last_4: str) -> list[dict]:
        """Fetch non-revoked, non-expired API keys matching the prefix/last-4 pair."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, user_id, key_hash, expires_at, scopes
                FROM api_key
                WHERE revoked = FALSE
                  AND (expires_at IS NULL OR expires_at > NOW())
                  AND key_prefix = $1
                  AND last_4 = $2
                """,
                key_prefix,
                last_4,
            )
            return [dict(row) for row in rows]

    async def update_api_key_last_used(self, key_id: int) -> None:
        """Update the last_used_at timestamp for an API key."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "UPDATE api_key SET last_used_at = NOW() WHERE id = $1",
                key_id,
            )

    # ============== Refresh Tokens ==============

    async def create_refresh_token(
        self,
        user_id: int,
        token_hash: str,
        expires_at: datetime,
        family_id: str,
        remember_me: bool = False,
        last_4: str | None = None,
    ) -> dict:
        """Store a refresh token in the database."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO refresh_token (user_id, token_hash, expires_at, family_id, remember_me, last_4)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id, user_id, family_id, expires_at, created_at, remember_me, last_4
                """,
                user_id,
                token_hash,
                expires_at,
                family_id,
                remember_me,
                last_4,
            )
            return dict(row) if row else {}

    async def list_active_refresh_tokens(self) -> list[dict]:
        """Fetch all non-revoked, non-expired refresh tokens."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, user_id, token_hash, family_id, expires_at, revoked_at, replaced_by, remember_me, last_4
                FROM refresh_token
                WHERE revoked_at IS NULL AND expires_at > NOW()
                """
            )
            return [dict(row) for row in rows]

    async def find_refresh_token_candidates(self, last_4: str) -> list[dict]:
        """Fetch refresh tokens matching the last-4 suffix.

        Includes active tokens and rotated tokens whose one-time grace period
        has not yet been consumed. This allows a recently-rotated refresh token
        to be reused once within a short grace window (multi-tab safety).
        """
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, user_id, token_hash, family_id, expires_at, revoked_at, replaced_by, remember_me, last_4
                FROM refresh_token
                WHERE expires_at > NOW() AND last_4 = $1
                  AND (
                      revoked_at IS NULL
                      OR (rotated_at IS NOT NULL AND grace_period_used = FALSE)
                  )
                """,
                last_4,
            )
            return [dict(row) for row in rows]

    async def get_refresh_token_replacement(self, token_id: int) -> int | None:
        """Return the token_id that replaced this token, if any."""
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchval(
                "SELECT replaced_by FROM refresh_token WHERE id = $1",
                token_id,
            )

    async def get_refresh_token_grace_status(self, token_id: int) -> dict | None:
        """Return rotated_at and grace_period_used for a refresh token."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT rotated_at, grace_period_used FROM refresh_token WHERE id = $1",
                token_id,
            )
            return dict(row) if row else None

    async def mark_refresh_token_grace_used(self, token_id: int) -> None:
        """Mark a refresh token's grace period as consumed."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "UPDATE refresh_token SET grace_period_used = TRUE WHERE id = $1",
                token_id,
            )

    async def rotate_refresh_token(
        self,
        old_token_id: int,
        token_hash: str,
        expires_at: datetime,
        remember_me: bool = False,
        last_4: str | None = None,
    ) -> dict:
        """Rotate a refresh token: revoke old, create new, link them."""
        async with acquire_connection(self._pool) as conn, conn.transaction():
            old_row = await conn.fetchrow(
                "SELECT user_id, family_id FROM refresh_token WHERE id = $1",
                old_token_id,
            )
            if not old_row:
                raise ValueError("Old refresh token not found")

            new_row = await conn.fetchrow(
                """
                INSERT INTO refresh_token (user_id, token_hash, expires_at, family_id, remember_me, last_4)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id, user_id, family_id, expires_at, created_at, remember_me, last_4
                """,
                old_row["user_id"],
                token_hash,
                expires_at,
                old_row["family_id"],
                remember_me,
                last_4,
            )

            await conn.execute(
                """
                UPDATE refresh_token
                SET revoked_at = NOW(), replaced_by = $1, rotated_at = NOW()
                WHERE id = $2
                """,
                new_row["id"],
                old_token_id,
            )

            return dict(new_row)

    async def revoke_refresh_token_family(self, family_id: str) -> None:
        """Revoke all refresh tokens in a family."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                UPDATE refresh_token
                SET revoked_at = NOW()
                WHERE family_id = $1 AND revoked_at IS NULL
                """,
                family_id,
            )

    async def revoke_all_user_refresh_tokens(self, user_id: int) -> None:
        """Revoke all refresh tokens for a user."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                UPDATE refresh_token
                SET revoked_at = NOW()
                WHERE user_id = $1 AND revoked_at IS NULL
                """,
                user_id,
            )

    # ============== Admin operations ==============

    async def list_users_paginated(self, page: int, page_size: int) -> tuple[int, list[asyncpg.Record]]:
        """List all users paginated."""
        offset = (page - 1) * page_size
        async with acquire_connection(self._pool) as conn:
            total = await conn.fetchval('SELECT COUNT(*) FROM "user"')
            rows = await conn.fetch(
                """
                SELECT id, uuid, email, name, surnames, profile_pic, role, active, create_date
                FROM "user"
                ORDER BY create_date DESC
                LIMIT $1 OFFSET $2
                """,
                page_size,
                offset,
            )
        return total or 0, rows

    async def count_other_admins(self, user_id: int) -> int:
        """Count active admins other than the given user."""
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchval(
                'SELECT COUNT(*) FROM "user" WHERE role = \'admin\' AND active = TRUE AND id != $1',
                user_id,
            ) or 0

    async def update_user_admin(self, user_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        """Update a user as admin. Returns the updated user row or None."""
        if not updates:
            async with acquire_connection(self._pool) as conn:
                row = await conn.fetchrow(
                    """
                    SELECT id, uuid, email, name, surnames, profile_pic, role, active, create_date
                    FROM "user" WHERE id::text = $1
                    """,
                    user_id,
                )
            return dict(row) if row else None

        set_clauses = ", ".join(f"{k} = ${i + 1}" for i, k in enumerate(updates.keys()))
        values = list(updates.values())
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                f"""
                UPDATE "user"
                SET {set_clauses}, write_date = NOW()
                WHERE id::text = ${len(values) + 1}
                RETURNING id, uuid, email, name, surnames, profile_pic, role, active, create_date
                """,
                *values,
                user_id,
            )
        return dict(row) if row else None

    async def deactivate_user_admin(self, user_id: str) -> bool:
        """Deactivate a user as admin."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                'UPDATE "user" SET active = FALSE WHERE id::text = $1',
                user_id,
            )
            return result.split()[-1] != "0"

    async def get_system_metrics(self) -> dict[str, Any]:
        """Get system-wide counts.

        Node counts are derived from each workspace's operation-log store;
        workspace, user, and share counts still come from PostgreSQL.
        """
        from app.relay.dependencies import get_relay_storage

        node_count = 0
        page_count = 0
        block_count = 0
        daily_count = 0
        day_class_uuid = SYSTEM_CLASS_UUIDS["day"]

        async with acquire_connection(self._pool) as conn:
            user_count = await conn.fetchval('SELECT COUNT(*) FROM "user"')
            workspace_count = await conn.fetchval("SELECT COUNT(*) FROM workspace WHERE active = TRUE")
            public_share_count = await conn.fetchval("SELECT COUNT(*) FROM node_public_share WHERE active = TRUE")
            user_share_count = await conn.fetchval("SELECT COUNT(*) FROM node_share WHERE active = TRUE")

            workspace_rows = await conn.fetch(
                "SELECT uuid::text AS uuid FROM workspace WHERE active = TRUE"
            )

        for ws_row in workspace_rows:
            store = WorkspaceStore(
                workspace_id=ws_row["uuid"],
                actor_id="system",
                relay_storage=get_relay_storage(),
            )
            try:
                await store.sync()
                node_count += (await store.query("SELECT COUNT(*) FROM node"))[0][0]
                page_count += (
                    await store.query("SELECT COUNT(*) FROM node WHERE kind = 'page'")
                )[0][0]
                block_count += (
                    await store.query("SELECT COUNT(*) FROM node WHERE kind = 'block'")
                )[0][0]
                daily_count += (
                    await store.query(
                        "SELECT COUNT(*) FROM node WHERE kind = 'page' AND class_ids LIKE ?",
                        (f"%{day_class_uuid}%",),
                    )
                )[0][0]
            finally:
                await store.close()

        data_dir = get_data_dir()
        storage_used = shutil.disk_usage(data_dir).used if data_dir.exists() else 0

        return {
            "nodes": {
                "total": node_count,
                "pages": page_count,
                "blocks": block_count,
                "daily_journals": daily_count,
            },
            "users": user_count,
            "workspaces": workspace_count,
            "shares": {
                "public": public_share_count,
                "user": user_share_count,
            },
            "storage_bytes": storage_used,
        }

    async def audit_assets(self, dry_run: bool) -> dict[str, Any]:
        """Audit asset files on disk vs active asset nodes.

        Asset-node membership is read from each workspace's operation-log derived
        state instead of the legacy ``node`` table.
        """
        from app.relay.dependencies import get_relay_storage

        data_dir = get_data_dir()
        workspaces_dir = data_dir / "workspaces"
        orphans: list[dict] = []
        missing_files: list[dict] = []

        async with acquire_connection(self._pool) as conn:
            workspaces = await conn.fetch(
                "SELECT id, uuid::text AS uuid FROM workspace WHERE active = TRUE"
            )

        for ws_row in workspaces:
            ws_uuid = ws_row["uuid"]
            ws_id = ws_row["id"]
            assets_dir = workspaces_dir / ws_uuid / "assets"
            if not assets_dir.exists():
                continue

            store = WorkspaceStore(
                workspace_id=ws_uuid,
                actor_id="system",
                relay_storage=get_relay_storage(),
            )
            try:
                await store.sync()
                asset_rows = await store.query(
                    "SELECT a.node_id, a.asset_hash FROM node_asset a JOIN node n ON n.id = a.node_id"
                )
                active_assets = {row["node_id"]: row["asset_hash"] for row in asset_rows}

                for asset_folder in assets_dir.iterdir():
                    if not asset_folder.is_dir():
                        continue
                    asset_uuid = asset_folder.name

                    if asset_uuid not in active_assets:
                        orphans.append({
                            "workspace_id": ws_id,
                            "workspace_uuid": ws_uuid,
                            "asset_uuid": asset_uuid,
                            "path": str(asset_folder),
                            "reason": "no_node",
                        })
                        if not dry_run:
                            shutil.rmtree(asset_folder, ignore_errors=True)
                            logger.info(f"[ASSET_AUDIT] Removed orphan folder: {asset_folder}")

                for asset_uuid in active_assets:
                    asset_folder = assets_dir / asset_uuid
                    if not asset_folder.exists():
                        missing_files.append({
                            "workspace_id": ws_id,
                            "workspace_uuid": ws_uuid,
                            "asset_uuid": asset_uuid,
                            "reason": "folder_missing",
                        })
            finally:
                await store.close()

        return {
            "dry_run": dry_run,
            "orphans": orphans,
            "orphan_count": len(orphans),
            "missing_files": missing_files,
            "missing_count": len(missing_files),
        }


class PostgresInviteRepository(BasePostgresRepository, InviteRepository):
    """Handles pending invite lookup and share creation."""

    def __init__(self, pool: asyncpg.Pool, workspace_id: int = 0, user_id: int | None = None):
        super().__init__(pool, workspace_id, user_id)

    async def get_pending_invite(self, token: str) -> Any | None:
        """Get an active pending invite by its UUID token."""
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchrow(
                """
                SELECT id, email, workspace_id, node_uuid, role, invited_by, expires_at
                FROM pending_invite
                WHERE uuid::text = $1 AND active = TRUE
                """,
                token,
            )

    async def expire_invite(self, invite_id: int) -> None:
        """Mark a pending invite as inactive."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "UPDATE pending_invite SET active = FALSE WHERE id = $1",
                invite_id,
            )

    async def apply_invite_shares(
        self,
        invite: Any,
        user_id: int,
    ) -> None:
        """Create workspace/node shares from an invite in a single transaction.

        Workspace membership stays in PostgreSQL; node-level sharing is emitted
        as an operation-log ``share.user.grant`` via ``WorkspaceStore``.
        """
        from app.relay.dependencies import get_relay_storage

        async with acquire_connection(self._pool) as conn, conn.transaction():
            if invite["workspace_id"]:
                perms = {
                    "viewer": (True, False, False, False, False),
                    "commenter": (True, False, False, False, True),
                    "editor": (True, True, True, False, True),
                    "admin": (True, True, True, True, True),
                }.get(invite["role"], (True, False, False, False, False))

                await conn.execute(
                    """
                    INSERT INTO workspace_share (workspace_id, user_id, can_read, can_write, can_create, can_delete, can_comment, active, create_uid, write_uid)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $8)
                    ON CONFLICT (workspace_id, user_id)
                    DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write,
                                  can_create = EXCLUDED.can_create, can_delete = EXCLUDED.can_delete,
                                  can_comment = EXCLUDED.can_comment, active = TRUE, write_uid = EXCLUDED.write_uid,
                                  write_date = NOW()
                    """,
                    invite["workspace_id"],
                    user_id,
                    perms[0],
                    perms[1],
                    perms[2],
                    perms[3],
                    perms[4],
                    invite["invited_by"],
                )
                await conn.execute(
                    "UPDATE workspace SET is_shared = TRUE WHERE id = $1",
                    invite["workspace_id"],
                )

            node_uuid = invite.get("node_uuid")
            if node_uuid:
                ws_uuid_row = await conn.fetchrow(
                    "SELECT uuid::text FROM workspace WHERE id = $1",
                    invite["workspace_id"],
                )
                if ws_uuid_row is None:
                    raise ValueError(f"Workspace {invite['workspace_id']} not found")
                ws_uuid = ws_uuid_row["uuid"]

                user_uuid_row = await conn.fetchrow(
                    'SELECT uuid::text FROM "user" WHERE id = $1',
                    user_id,
                )
                if user_uuid_row is None:
                    raise ValueError(f"User {user_id} not found")
                user_uuid = user_uuid_row["uuid"]

                role = (invite.get("role") or "viewer").lower()
                permission = "write" if role in ("editor", "admin", "write") else "read"
                share_id = generate_uuid()

                store = WorkspaceStore(
                    workspace_id=ws_uuid,
                    actor_id=user_uuid,
                    relay_storage=get_relay_storage(),
                )
                try:
                    await store.grant_user_share(
                        share_id=share_id,
                        node_uuid=str(node_uuid),
                        user_id=user_uuid,
                        permission=permission,
                    )
                finally:
                    await store.close()

            await conn.execute(
                "UPDATE pending_invite SET active = FALSE WHERE id = $1",
                invite["id"],
            )
