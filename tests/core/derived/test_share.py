"""Unit tests for the share derived-state applier."""

from __future__ import annotations

import pytest

from app.core.derived import replay_operations
from tests.core.derived.conftest import make_operation

pytestmark = pytest.mark.unit


class TestPublicShare:
    def test_public_create_creates_row(self) -> None:
        ops = [
            make_operation(
                "share.public.create",
                {
                    "shareId": "share-1",
                    "nodeId": "page-1",
                    "slug": "my-page",
                    "passwordHash": "hashed-secret",
                    "expiryDate": "2026-12-31",
                },
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT * FROM node_public_share WHERE share_id = ?", ("share-1",)
        ).fetchone()
        assert row is not None
        assert row["node_id"] == "page-1"
        assert row["workspace_id"] == "ws-1"
        assert row["slug"] == "my-page"
        assert row["password_hash"] == "hashed-secret"
        assert row["expiry_date"] == "2026-12-31"
        conn.close()

    def test_public_revoke_removes_row(self) -> None:
        ops = [
            make_operation(
                "share.public.create",
                {"shareId": "share-1", "nodeId": "page-1"},
            ),
            make_operation("share.public.revoke", {"shareId": "share-1"}),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT 1 FROM node_public_share WHERE share_id = ?", ("share-1",)
        ).fetchone()
        assert row is None
        conn.close()


class TestUserShare:
    def test_user_grant_creates_row(self) -> None:
        ops = [
            make_operation(
                "share.user.grant",
                {
                    "shareId": "share-1",
                    "nodeId": "page-1",
                    "targetUserId": "user-2",
                    "permissionBits": 7,
                },
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT * FROM node_user_share WHERE share_id = ?", ("share-1",)
        ).fetchone()
        assert row is not None
        assert row["node_id"] == "page-1"
        assert row["target_user_id"] == "user-2"
        assert row["permission_bits"] == 7
        conn.close()

    def test_user_grant_upserts_permission_bits(self) -> None:
        ops = [
            make_operation(
                "share.user.grant",
                {
                    "shareId": "share-1",
                    "nodeId": "page-1",
                    "targetUserId": "user-2",
                    "permissionBits": 1,
                },
            ),
            make_operation(
                "share.user.grant",
                {
                    "shareId": "share-1",
                    "nodeId": "page-1",
                    "targetUserId": "user-2",
                    "permissionBits": 7,
                },
            ),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT permission_bits FROM node_user_share WHERE share_id = ?", ("share-1",)
        ).fetchone()
        assert row["permission_bits"] == 7
        conn.close()

    def test_user_revoke_removes_row(self) -> None:
        ops = [
            make_operation(
                "share.user.grant",
                {
                    "shareId": "share-1",
                    "nodeId": "page-1",
                    "targetUserId": "user-2",
                    "permissionBits": 7,
                },
            ),
            make_operation("share.user.revoke", {"shareId": "share-1"}),
        ]
        conn = replay_operations(ops)
        row = conn.execute(
            "SELECT 1 FROM node_user_share WHERE share_id = ?", ("share-1",)
        ).fetchone()
        assert row is None
        conn.close()
