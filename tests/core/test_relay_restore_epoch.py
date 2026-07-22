"""Tests for restore_epoch error handling in relay dependencies."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException, status

from app.relay.dependencies import get_workspace_restore_epoch

pytestmark = pytest.mark.unit


@pytest.mark.asyncio
async def test_get_workspace_restore_epoch_returns_zero_for_missing_workspace() -> None:
    """A missing workspace row returns 0 (anonymous/unknown workspace case)."""
    mock_pool = AsyncMock()
    mock_pool.fetchrow = AsyncMock(return_value=None)

    with patch("app.relay.dependencies.get_pool", return_value=mock_pool):
        epoch = await get_workspace_restore_epoch("00000000-0000-0000-0000-000000000000")
        assert epoch == 0


@pytest.mark.asyncio
async def test_get_workspace_restore_epoch_returns_value_for_workspace() -> None:
    mock_pool = AsyncMock()
    mock_pool.fetchrow = AsyncMock(return_value={"restore_epoch": 5})

    with patch("app.relay.dependencies.get_pool", return_value=mock_pool):
        epoch = await get_workspace_restore_epoch("11111111-1111-1111-1111-111111111111")
        assert epoch == 5


@pytest.mark.asyncio
async def test_get_workspace_restore_epoch_propagates_db_error_as_503() -> None:
    """Genuine DB errors must be propagated as 503 so the client retries
    instead of interpreting the failure as a workspace restore.
    """
    mock_pool = AsyncMock()
    mock_pool.fetchrow = AsyncMock(side_effect=ConnectionError("pool exhausted"))

    with (
        patch("app.relay.dependencies.get_pool", return_value=mock_pool),
        pytest.raises(HTTPException) as exc_info,
    ):
        await get_workspace_restore_epoch("22222222-2222-2222-2222-222222222222")

    assert exc_info.value.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert "pool exhausted" in str(exc_info.value.detail)
