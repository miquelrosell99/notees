"""Tests for plugin loader discovery."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from app.plugins.core.loader import PluginLoader
from app.plugins.core.manifest import PluginManifest


def test_loader_discovery() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        builtin = Path(tmp) / "builtin"
        external = Path(tmp) / "external"
        builtin.mkdir()
        external.mkdir()

        plugin_dir = builtin / "test_plugin"
        plugin_dir.mkdir()
        manifest = PluginManifest(
            id="notees.test_plugin",
            name="Test Plugin",
            version="1.0.0",
            backend={"entrypoint": "test_plugin:setup"},
        )

        (plugin_dir / "manifest.json").write_text(
            manifest.model_dump_json(), encoding="utf-8"
        )

        loader = PluginLoader(builtin, external)
        discovered = loader.discover()

    assert len(discovered) == 1
    assert discovered[0].name == "test_plugin"


def test_loader_load_manifest() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        builtin = Path(tmp) / "builtin"
        builtin.mkdir()
        plugin_dir = builtin / "test_plugin"
        plugin_dir.mkdir()

        (plugin_dir / "manifest.json").write_text(
            json.dumps(
                {
                    "id": "notees.test_plugin",
                    "name": "Test Plugin",
                    "version": "1.0.0",
                    "backend": {"entrypoint": "test_plugin:setup"},
                }
            ),
            encoding="utf-8",
        )
        loader = PluginLoader(builtin, Path(tmp) / "external")
        loaded = loader.load_manifest(plugin_dir)
    assert loaded.id == "notees.test_plugin"
    assert loaded.builtin is True
