"""Unit tests for the asset derived-state applier."""

from __future__ import annotations

import pytest

from app.core.derived import replay_operations
from tests.core.derived.conftest import make_operation

pytestmark = pytest.mark.unit


class TestAssetApplier:
    def test_asset_upload_creates_node_asset_row(self) -> None:
        ops = [
            make_operation(
                "node.create",
                {"nodeId": "asset-node", "kind": "block", "index": 0},
            ),
            make_operation(
                "asset.upload",
                {
                    "nodeId": "asset-node",
                    "assetHash": "sha256-deadbeef",
                    "mimeType": "image/webp",
                    "sizeBytes": 1024,
                    "originalName": "photo.webp",
                },
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT * FROM node_asset WHERE node_id = ?", ("asset-node",)
        ).fetchone()
        assert row is not None
        assert row["asset_hash"] == "sha256-deadbeef"
        assert row["mime_type"] == "image/webp"
        assert row["size_bytes"] == 1024
        assert row["original_name"] == "photo.webp"
        conn.close()

    def test_asset_upload_overwrites_existing_row(self) -> None:
        ops = [
            make_operation(
                "node.create",
                {"nodeId": "asset-node", "kind": "block", "index": 0},
            ),
            make_operation(
                "asset.upload",
                {
                    "nodeId": "asset-node",
                    "assetHash": "sha256-old",
                    "mimeType": "image/png",
                    "sizeBytes": 10,
                    "originalName": "old.png",
                },
            ),
            make_operation(
                "asset.upload",
                {
                    "nodeId": "asset-node",
                    "assetHash": "sha256-new",
                    "mimeType": "image/jpeg",
                    "sizeBytes": 20,
                    "originalName": "new.jpg",
                },
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT * FROM node_asset WHERE node_id = ?", ("asset-node",)
        ).fetchone()
        assert row["asset_hash"] == "sha256-new"
        assert row["mime_type"] == "image/jpeg"
        conn.close()

    def test_asset_delete_removes_node_asset_row(self) -> None:
        ops = [
            make_operation(
                "node.create",
                {"nodeId": "asset-node", "kind": "block", "index": 0},
            ),
            make_operation(
                "asset.upload",
                {
                    "nodeId": "asset-node",
                    "assetHash": "sha256-deadbeef",
                    "mimeType": "image/webp",
                    "sizeBytes": 1024,
                    "originalName": "photo.webp",
                },
            ),
            make_operation("asset.delete", {"nodeId": "asset-node"}),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT 1 FROM node_asset WHERE node_id = ?", ("asset-node",)
        ).fetchone()
        assert row is None
        conn.close()
