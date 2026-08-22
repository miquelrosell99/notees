"""Static share HTML file path helpers."""

from __future__ import annotations

import uuid
from pathlib import Path

from ...db.connection import get_data_dir


def _validate_share_uuid(share_uuid: str) -> uuid.UUID:
    """Parse ``share_uuid`` as a UUID so it can never escape the shares directory."""
    try:
        return uuid.UUID(share_uuid)
    except ValueError:
        raise ValueError(f"Invalid share UUID: {share_uuid!r}") from None


def get_static_share_path(share_uuid: str) -> Path:
    """Get the file path for a static share HTML file."""
    parsed = _validate_share_uuid(share_uuid)
    shares_dir = get_data_dir() / "static-shares"
    shares_dir.mkdir(parents=True, exist_ok=True)
    return shares_dir / f"{parsed}.html"


def delete_share_html(share_uuid: str) -> None:
    """Delete the static HTML file for a share, if it exists."""
    path = get_static_share_path(share_uuid)
    if path.exists():
        path.unlink()
