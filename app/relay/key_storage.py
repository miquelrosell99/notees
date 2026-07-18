"""PostgreSQL-backed storage for wrapped workspace keys.

This module implements a *prototype* server-side key-management scheme. Each
workspace has a single 32-byte master key. The master key is encrypted at rest
with a key derived from the workspace id and ``SECRET_KEY``. Every member holds
a copy of the master key wrapped with a key derived from their own user id and
``SECRET_KEY``.

TODO(D6): Phase 6 should move to true client-side key generation. In that
scheme the client generates the master key, wraps it locally for each member
with the member's public key, and the server only stores opaque ciphertext.
"""

from __future__ import annotations

import os
from typing import Any

import asyncpg

from app.core.crypto import (
    derive_user_wrapping_key,
    derive_workspace_key,
    unwrap_key,
    wrap_key,
)
from app.db.connection import get_connection

_SCHEMA = """
CREATE TABLE IF NOT EXISTS workspace_key (
    workspace_id TEXT PRIMARY KEY,
    master_key_ciphertext TEXT NOT NULL,
    master_key_iv TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    rotated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_member_key (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    wrapped_key_ciphertext TEXT NOT NULL,
    wrapped_key_iv TEXT NOT NULL,
    key_version INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
);
"""


class WorkspaceKeyStorage:
    """Persistent storage for workspace master keys and per-member wrapped keys."""

    def __init__(self, pool: asyncpg.Pool | None = None) -> None:
        self._pool = pool

    async def _ensure_schema(self, conn: asyncpg.Connection) -> None:
        """Create key-management tables on ``conn`` if they do not already exist."""
        await conn.execute(_SCHEMA)

    async def get_or_create_master_key(
        self,
        workspace_id: str,
        secret_key: str,
    ) -> bytes:
        """Return the workspace master key, creating it if necessary.

        The master key is stored encrypted with the workspace-derived key. If no
        row exists yet, a fresh random 32-byte key is generated and persisted.
        """
        workspace_wrapping_key = derive_workspace_key(workspace_id, secret_key)

        if self._pool is not None:
            async with self._pool.acquire() as conn:
                await self._ensure_schema(conn)
                return await self._get_or_create_master_key_with_conn(
                    conn, workspace_id, workspace_wrapping_key
                )

        async with get_connection() as conn:
            await self._ensure_schema(conn)
            return await self._get_or_create_master_key_with_conn(
                conn, workspace_id, workspace_wrapping_key
            )

    async def _get_or_create_master_key_with_conn(
        self,
        conn: asyncpg.Connection,
        workspace_id: str,
        workspace_wrapping_key: bytes,
    ) -> bytes:
        row = await conn.fetchrow(
            """
            SELECT master_key_ciphertext, master_key_iv
            FROM workspace_key
            WHERE workspace_id = $1
            """,
            workspace_id,
        )
        if row is not None:
            return unwrap_key(
                {"ciphertext": row["master_key_ciphertext"], "iv": row["master_key_iv"]},
                workspace_wrapping_key,
            )

        master_key = os.urandom(32)
        wrapped = wrap_key(master_key, workspace_wrapping_key)

        await conn.execute(
            """
            INSERT INTO workspace_key (
                workspace_id, master_key_ciphertext, master_key_iv, version, rotated_at
            )
            VALUES ($1, $2, $3, 1, NOW())
            ON CONFLICT (workspace_id) DO NOTHING
            """,
            workspace_id,
            wrapped["ciphertext"],
            wrapped["iv"],
        )

        # Another concurrent caller may have created the row; read it back to
        # ensure all callers converge on the same master key.
        row = await conn.fetchrow(
            """
            SELECT master_key_ciphertext, master_key_iv
            FROM workspace_key
            WHERE workspace_id = $1
            """,
            workspace_id,
        )
        if row is None:
            raise RuntimeError("Failed to create workspace master key")

        return unwrap_key(
            {"ciphertext": row["master_key_ciphertext"], "iv": row["master_key_iv"]},
            workspace_wrapping_key,
        )

    async def get_wrapped_key_for_user(
        self,
        workspace_id: str,
        user_id: str,
        secret_key: str,
    ) -> dict[str, Any]:
        """Return the wrapped workspace key for ``user_id``.

        If the user does not have a wrapped key yet, the master key is
        decrypted, wrapped with the user-derived wrapping key, and persisted.
        """
        master_key = await self.get_or_create_master_key(workspace_id, secret_key)
        user_wrapping_key = derive_user_wrapping_key(user_id, secret_key)

        if self._pool is not None:
            async with self._pool.acquire() as conn:
                await self._ensure_schema(conn)
                return await self._get_or_create_member_key_with_conn(
                    conn, workspace_id, user_id, master_key, user_wrapping_key
                )

        async with get_connection() as conn:
            await self._ensure_schema(conn)
            return await self._get_or_create_member_key_with_conn(
                conn, workspace_id, user_id, master_key, user_wrapping_key
            )

    async def _get_or_create_member_key_with_conn(
        self,
        conn: asyncpg.Connection,
        workspace_id: str,
        user_id: str,
        master_key: bytes,
        user_wrapping_key: bytes,
    ) -> dict[str, Any]:
        row = await conn.fetchrow(
            """
            SELECT wrapped_key_ciphertext, wrapped_key_iv, key_version
            FROM workspace_member_key
            WHERE workspace_id = $1 AND user_id = $2
            """,
            workspace_id,
            user_id,
        )
        if row is not None:
            return {
                "workspace_id": workspace_id,
                "user_id": user_id,
                "ciphertext": row["wrapped_key_ciphertext"],
                "iv": row["wrapped_key_iv"],
                "key_version": row["key_version"],
            }

        # Get the current key version from the workspace master key row.
        version_row = await conn.fetchrow(
            "SELECT version FROM workspace_key WHERE workspace_id = $1",
            workspace_id,
        )
        if version_row is None:
            raise RuntimeError("Workspace master key missing during member key creation")
        key_version = version_row["version"]

        wrapped = wrap_key(master_key, user_wrapping_key)
        await conn.execute(
            """
            INSERT INTO workspace_member_key (
                workspace_id, user_id, wrapped_key_ciphertext, wrapped_key_iv, key_version
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (workspace_id, user_id) DO NOTHING
            """,
            workspace_id,
            user_id,
            wrapped["ciphertext"],
            wrapped["iv"],
            key_version,
        )

        row = await conn.fetchrow(
            """
            SELECT wrapped_key_ciphertext, wrapped_key_iv, key_version
            FROM workspace_member_key
            WHERE workspace_id = $1 AND user_id = $2
            """,
            workspace_id,
            user_id,
        )
        if row is None:
            raise RuntimeError("Failed to create member wrapped key")

        return {
            "workspace_id": workspace_id,
            "user_id": user_id,
            "ciphertext": row["wrapped_key_ciphertext"],
            "iv": row["wrapped_key_iv"],
            "key_version": row["key_version"],
        }

    async def rotate_master_key(
        self,
        workspace_id: str,
        secret_key: str,
    ) -> None:
        """Generate a new master key and re-wrap it for all existing members."""
        workspace_wrapping_key = derive_workspace_key(workspace_id, secret_key)
        new_master_key = os.urandom(32)
        wrapped_master = wrap_key(new_master_key, workspace_wrapping_key)

        async def _rotate(conn: asyncpg.Connection) -> None:
            await self._ensure_schema(conn)
            async with conn.transaction():
                # Lock the workspace key row to serialize rotations.
                current = await conn.fetchrow(
                    """
                    SELECT version
                    FROM workspace_key
                    WHERE workspace_id = $1
                    FOR UPDATE
                    """,
                    workspace_id,
                )
                if current is None:
                    raise ValueError(f"No master key found for workspace {workspace_id}")

                new_version = current["version"] + 1

                await conn.execute(
                    """
                    UPDATE workspace_key
                    SET master_key_ciphertext = $2,
                        master_key_iv = $3,
                        version = $4,
                        rotated_at = NOW()
                    WHERE workspace_id = $1
                    """,
                    workspace_id,
                    wrapped_master["ciphertext"],
                    wrapped_master["iv"],
                    new_version,
                )

                member_rows = await conn.fetch(
                    """
                    SELECT user_id
                    FROM workspace_member_key
                    WHERE workspace_id = $1
                    """,
                    workspace_id,
                )

                for member_row in member_rows:
                    member_user_id = member_row["user_id"]
                    user_wrapping_key = derive_user_wrapping_key(member_user_id, secret_key)
                    wrapped = wrap_key(new_master_key, user_wrapping_key)
                    await conn.execute(
                        """
                        UPDATE workspace_member_key
                        SET wrapped_key_ciphertext = $3,
                            wrapped_key_iv = $4,
                            key_version = $5
                        WHERE workspace_id = $1 AND user_id = $2
                        """,
                        workspace_id,
                        member_user_id,
                        wrapped["ciphertext"],
                        wrapped["iv"],
                        new_version,
                    )

        if self._pool is not None:
            async with self._pool.acquire() as conn:
                await _rotate(conn)
        else:
            async with get_connection() as conn:
                await _rotate(conn)
