"""Tests for plugin manifest validation."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from app.plugins.core.manifest import PluginManifest


def test_valid_manifest() -> None:
    manifest = PluginManifest(
        id="notees.test",
        name="Test Plugin",
        version="1.0.0",
        backend={"entrypoint": "test_plugin:setup"},
    )
    assert manifest.id == "notees.test"
    assert manifest.version == "1.0.0"


def test_manifest_requires_entrypoint() -> None:
    with pytest.raises(ValueError):
        PluginManifest(id="notees.test", name="Test", version="1.0.0")


def test_manifest_invalid_version() -> None:
    with pytest.raises(ValueError):
        PluginManifest(
            id="notees.test",
            name="Test",
            version="1",
            backend={"entrypoint": "test_plugin:setup"},
        )


def test_manifest_from_file() -> None:
    data = {
        "id": "notees.test",
        "name": "Test",
        "version": "1.0.0",
        "backend": {"entrypoint": "test_plugin:setup"},
        "permissions": ["read_nodes"],
    }
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "manifest.json"
        import json

        path.write_text(json.dumps(data), encoding="utf-8")
        manifest = PluginManifest.from_file(path)
    assert manifest.permissions == ["read_nodes"]
