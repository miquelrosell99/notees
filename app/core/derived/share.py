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
    created_at = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None
    created_by = op.envelope.actor_id

    conn.execute(
        """
        INSERT INTO node_public_share (
            node_id, slug, password_hash, created_at, created_by,
            share_id, workspace_id, expiry_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
            slug = excluded.slug,
            password_hash = excluded.password_hash,
            created_at = excluded.created_at,
            created_by = excluded.created_by,
            share_id = excluded.share_id,
            workspace_id = excluded.workspace_id,
            expiry_date = excluded.expiry_date
        """,
        (node_id, slug, password_hash, created_at, created_by, share_id, workspace_id, expiry_date),
    )


def apply_share_public_revoke(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``share.public.revoke`` operation."""
    share_id = op.payload["shareId"]
    conn.execute("DELETE FROM node_public_share WHERE share_id = ?", (share_id,))
    # Fallback: some callers emit the node id directly.
    node_id = op.payload.get("nodeId")
    if node_id:
        conn.execute("DELETE FROM node_public_share WHERE node_id = ?", (node_id,))


def apply_share_user_grant(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``share.user.grant`` operation.

    Payload fields:
        - shareId: UUIDv7 of the user share.
        - nodeId: shared node UUIDv7.
        - targetUserId: recipient user UUIDv7.
        - permissionBits: integer permission bitmask.
        - role: optional role name (defaults to "").
    """
    payload = op.payload
    share_id = payload["shareId"]
    node_id = payload["nodeId"]
    target_user_id = payload["targetUserId"]
    permission_bits = payload.get("permissionBits", 0)
    role = payload.get("role", "")
    created_at = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None
    created_by = op.envelope.actor_id

    conn.execute(
        """
        INSERT INTO node_user_share (
            node_id, user_id, role, created_at, created_by,
            share_id, target_user_id, permission_bits
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id, user_id) DO UPDATE SET
            role = excluded.role,
            created_at = excluded.created_at,
            created_by = excluded.created_by,
            share_id = excluded.share_id,
            target_user_id = excluded.target_user_id,
            permission_bits = excluded.permission_bits
        """,
        (
            node_id,
            target_user_id,
            role,
            created_at,
            created_by,
            share_id,
            target_user_id,
            permission_bits,
        ),
    )


def apply_share_user_revoke(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``share.user.revoke`` operation."""
    share_id = op.payload["shareId"]
    conn.execute("DELETE FROM node_user_share WHERE share_id = ?", (share_id,))
    # Fallback for callers that emit the node/user pair.
    node_id = op.payload.get("nodeId")
    user_id = op.payload.get("targetUserId")
    if node_id and user_id:
        conn.execute(
            "DELETE FROM node_user_share WHERE node_id = ? AND user_id = ?",
            (node_id, user_id),
        )
