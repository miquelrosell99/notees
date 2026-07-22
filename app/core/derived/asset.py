"""Asset derived-state applier.

Maps a node to the metadata of a content-addressed blob. The blob bytes live
outside the operation log; the derived table is used to resolve a node to its
file metadata for downloads and share rendering.
"""

from __future__ import annotations

import sqlite3

from app.core.operation import Operation


def apply_asset_upload(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply an ``asset.upload`` operation.

    Payload fields:
        - nodeId: UUIDv7 of the asset node.
        - assetHash: SHA-256 of the blob.
        - mimeType: MIME type of the uploaded file.
        - sizeBytes: file size in bytes.
        - originalName: original filename.
    """
    payload = op.payload
    node_id = payload["nodeId"]
    uploaded_at = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None
    conn.execute(
        """
        INSERT INTO node_asset (node_id, asset_hash, mime_type, size, original_name, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id, asset_hash) DO UPDATE SET
            mime_type = excluded.mime_type,
            size = excluded.size,
            original_name = excluded.original_name,
            uploaded_at = excluded.uploaded_at
        """,
        (
            node_id,
            payload["assetHash"],
            payload["mimeType"],
            payload["sizeBytes"],
            payload["originalName"],
            uploaded_at,
        ),
    )


def apply_asset_delete(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply an ``asset.delete`` operation by removing the node_asset row."""
    node_id = op.payload["nodeId"]
    conn.execute("DELETE FROM node_asset WHERE node_id = ?", (node_id,))
