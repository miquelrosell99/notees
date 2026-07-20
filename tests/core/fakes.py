"""Test fakes for core operation-log tests."""

from __future__ import annotations


class FakeKeyStorage:
    """In-memory key storage that returns a fixed 32-byte master key.

    This avoids requiring a PostgreSQL connection for WorkspaceKeyStorage in
    unit tests.
    """

    async def get_or_create_master_key(
        self,
        workspace_id: str,  # noqa: ARG002
        secret_key: str,  # noqa: ARG002
    ) -> bytes:
        return b"0" * 32
