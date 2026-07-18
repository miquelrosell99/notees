"""Share metadata derived-state applier."""

from __future__ import annotations

import sqlite3

from app.core.operation import Operation


def apply_share_public_create(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``share.public.create`` operation.

    Payload fields:
        - shareId: UUIDv7 of the public share.
        - nodeId: shared node UUIDv7.
        - slug: optional public slug.
        - passwordHash: optional password hash.
        - expiryDate: optional ISO-8601 expiry date.
    """
    payload = op.payload
    share_id = payload["shareId"]
    node_id = payload["nodeId"]
    workspace_id = op.envelope.workspace_id
    slug = payload.get("slug")
    password_hash = payload.get("passwordHash")
    expiry_date = payload.get("expiryDate")

    conn.execute(
        """
        INSERT INTO node_public_share (
            share_id, node_id, workspace_id, slug, password_hash, expiry_date
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(share_id) DO UPDATE SET
            node_id = excluded.node_id,
            workspace_id = excluded.workspace_id,
            slug = excluded.slug,
            password_hash = excluded.password_hash,
            expiry_date = excluded.expiry_date
        """,
        (share_id, node_id, workspace_id, slug, password_hash, expiry_date),
    )


def apply_share_public_revoke(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``share.public.revoke`` operation."""
    share_id = op.payload["shareId"]
    conn.execute("DELETE FROM node_public_share WHERE share_id = ?", (share_id,))


def apply_share_user_grant(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``share.user.grant`` operation.

    Payload fields:
        - shareId: UUIDv7 of the user share.
        - nodeId: shared node UUIDv7.
        - targetUserId: recipient user UUIDv7.
        - permissionBits: integer permission bitmask.
    """
    payload = op.payload
    share_id = payload["shareId"]
    node_id = payload["nodeId"]
    target_user_id = payload["targetUserId"]
    permission_bits = payload.get("permissionBits", 0)

    conn.execute(
        """
        INSERT INTO node_user_share (
            share_id, node_id, target_user_id, permission_bits
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(share_id) DO UPDATE SET
            node_id = excluded.node_id,
            target_user_id = excluded.target_user_id,
            permission_bits = excluded.permission_bits
        """,
        (share_id, node_id, target_user_id, permission_bits),
    )


def apply_share_user_revoke(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``share.user.revoke`` operation."""
    share_id = op.payload["shareId"]
    conn.execute("DELETE FROM node_user_share WHERE share_id = ?", (share_id,))
