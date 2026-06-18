"""Filesystem path helpers.

These helpers are used by both the DB connection layer and infrastructure
adapters such as ``AssetFileService``. Keeping them in a neutral utility module
avoids coupling domain/infrastructure code to connection-management internals.
"""

from __future__ import annotations

from pathlib import Path

from app.config import settings


def get_data_dir() -> Path:
    """Get the base data directory for assets.

    Reads from settings.database_dir so tests can override it.
    """
    return settings.database_dir


def get_workspace_dir(workspace_uuid: str) -> Path:
    """Get the main directory for a workspace."""
    return get_data_dir() / "workspaces" / workspace_uuid


def get_workspace_assets_dir(workspace_uuid: str) -> Path:
    """Get the assets directory for a workspace.

    Args:
        workspace_uuid: The workspace UUID (not the integer ID)

    Assets are stored as files named with their node UUID.
    Structure: data/workspaces/{workspace_uuid}/assets/
    """
    assets_dir = get_data_dir() / "workspaces" / workspace_uuid / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    return assets_dir


def get_export_dir(workspace_uuid: str) -> Path:
    """Get the export directory for a workspace.

    Args:
        workspace_uuid: The workspace UUID (not the integer ID)
    """
    export_dir = get_data_dir() / "workspaces" / workspace_uuid / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    return export_dir
