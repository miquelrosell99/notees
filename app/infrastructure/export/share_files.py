"""Static share HTML file path helpers."""

from __future__ import annotations

from pathlib import Path

from ...db.connection import get_data_dir


def get_static_share_path(share_uuid: str) -> Path:
    """Get the file path for a static share HTML file."""
    shares_dir = get_data_dir() / "static-shares"
    shares_dir.mkdir(parents=True, exist_ok=True)
    return shares_dir / f"{share_uuid}.html"


def delete_share_html(share_uuid: str) -> None:
    """Delete the static HTML file for a share, if it exists."""
    path = get_static_share_path(share_uuid)
    if path.exists():
        path.unlink()
