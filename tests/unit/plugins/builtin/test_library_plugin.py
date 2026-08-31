"""Tests for the builtin Library plugin package (notees.library).

The Library is primarily a view plugin; since Task 13 it also ships a small
backend (add-by-identifier routes — metadata providers are called
server-side). These tests pin the packaging contract: the manifest
validates, the plugin is discovered as a builtin, and — unlike other
builtins — it ships disabled by default (Decision 23: plugin enablement is
the on/off toggle).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.plugins.core.loader import PluginLoader
from app.plugins.core.manifest import PluginManifest

pytestmark = pytest.mark.unit

BUILTIN_DIR = Path(__file__).parents[4] / "app" / "plugins" / "builtin"
LIBRARY_DIR = BUILTIN_DIR / "library"


def test_library_manifest_validates() -> None:
    manifest = PluginManifest.from_file(LIBRARY_DIR / "manifest.json")
    assert manifest.id == "notees.library"
    assert manifest.name == "Library"
    assert manifest.frontend.entrypoint is not None
    # View plugin + add-by-identifier backend routes (Task 13).
    assert manifest.backend.entrypoint is not None
    assert "router" in manifest.permissions
    contributed_view_ids = [v.id for v in manifest.contributes.views]
    assert "library" in contributed_view_ids
    contributed_sidebar = {item.id: item.view_id for item in manifest.contributes.sidebar_items}
    assert contributed_sidebar.get("library-sidebar") == "library"


def test_library_discovered_as_builtin() -> None:
    loader = PluginLoader(BUILTIN_DIR, Path("/nonexistent-external"))
    discovered = loader.discover()
    assert LIBRARY_DIR in discovered


def test_library_ships_disabled_by_default() -> None:
    """Builtins default to enabled, but an explicit enabledByDefault=false is honored."""
    loader = PluginLoader(BUILTIN_DIR, Path("/nonexistent-external"))
    manifest = loader.load_manifest(LIBRARY_DIR)
    assert manifest.builtin is True
    assert manifest.enabled_by_default is False


def test_builtin_without_explicit_flag_still_defaults_to_enabled(tmp_path: Path) -> None:
    """Backwards compatibility: builtins that don't declare the flag stay enabled."""
    plugin_dir = tmp_path / "builtin" / "legacy"
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "manifest.json").write_text(
        json.dumps(
            {
                "id": "notees.legacy",
                "name": "Legacy",
                "version": "1.0.0",
                "frontend": {"entrypoint": "./dist/plugin.js"},
            }
        ),
        encoding="utf-8",
    )
    loader = PluginLoader(tmp_path / "builtin", tmp_path / "external")
    manifest = loader.load_manifest(plugin_dir)
    assert manifest.builtin is True
    assert manifest.enabled_by_default is True


def test_library_registered_but_not_enabled(tmp_path: Path, monkeypatch) -> None:
    """load_plugins registers the Library without running setup or mounting routes."""
    from fastapi import FastAPI

    from app.config import settings
    from app.plugins.core.manager import PluginManager

    monkeypatch.setattr(settings, "database_dir", tmp_path)
    manager = PluginManager()
    manager.builtin_dir = BUILTIN_DIR
    manager.loader.builtin_dir = BUILTIN_DIR
    manager.external_dir = tmp_path / "plugins"
    manager.bind_app(FastAPI())

    manager.load_plugins()

    plugin = manager.get_plugin("notees.library")
    assert plugin is not None
    assert plugin.enabled is False
    assert plugin.backend_setup_failed is False
    # Disabled: setup never ran, so no router is registered or mounted.
    assert manager.registry.get_router_registration("notees.library") is None

    # Restartless toggle runs setup (registering the router) on enable.
    assert manager.set_enabled("notees.library", True) is True
    assert plugin.enabled is True
    assert manager.registry.get_router_registration("notees.library") is not None
    assert manager.set_enabled("notees.library", False) is True
    assert plugin.enabled is False
